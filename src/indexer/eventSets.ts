/**
 * Event sets: which logs to index for a contract beyond the standard ERC-20 Transfer, and how
 * to classify them. A contract picks its set with contracts.event_set.
 *
 * Each event is a human-readable ABI fragment (indexed flags matter for decoding) plus:
 *  - category: administrative grouping shown in the UI
 *  - supply:   set when the event changes total supply WITHOUT a matching Transfer from/to the
 *              zero address (e.g. Tether's Issue/Redeem). Such events are counted as mints or
 *              burns in metrics and stored with kind 'mint'/'burn'. Events that merely accompany
 *              a zero-address Transfer (e.g. FiatToken's Mint/Burn) must NOT set this, or supply
 *              would be counted twice.
 *  - amountArg / fromArg / toArg: which decoded arguments fill events.amount/from/to
 *  - freezeList: set on the events that put an address on the contract's blacklist ('add') or
 *              take it off ('remove'); the address is the event's `to`. The latest of these per
 *              address says whether it is frozen now.
 *
 * transferToZeroBurns (default true) says whether a Transfer to the zero address destroys the
 * tokens. Tether's transfer() just moves them to 0x0, where they stay in totalSupply, so for
 * Tether those are ordinary transfers and only Redeem/DestroyedBlackFunds burn.
 */
export type EventCategory = 'freeze' | 'minter' | 'role' | 'pause' | 'upgrade' | 'issuance' | 'config';

export interface EventDefinition {
  abi: string;
  category: EventCategory;
  supply?: 'mint' | 'burn';
  amountArg?: string;
  fromArg?: string;
  toArg?: string;
  freezeList?: 'add' | 'remove';
}

export interface EventSet {
  name: string;
  events: EventDefinition[];
  transferToZeroBurns?: boolean;
}

const ERC20: EventSet = { name: 'erc20', events: [] };

// Circle's FiatToken (USDC, EURC) behind a ZeppelinOS AdminUpgradeabilityProxy
const FIATTOKEN: EventSet = {
  name: 'fiattoken',
  events: [
    { abi: 'event Mint(address indexed minter, address indexed to, uint256 amount)', category: 'issuance', amountArg: 'amount', fromArg: 'minter', toArg: 'to' },
    { abi: 'event Burn(address indexed burner, uint256 amount)', category: 'issuance', amountArg: 'amount', fromArg: 'burner' },
    { abi: 'event MinterConfigured(address indexed minter, uint256 minterAllowedAmount)', category: 'minter', amountArg: 'minterAllowedAmount', toArg: 'minter' },
    { abi: 'event MinterRemoved(address indexed oldMinter)', category: 'minter', toArg: 'oldMinter' },
    { abi: 'event MasterMinterChanged(address indexed newMasterMinter)', category: 'role', toArg: 'newMasterMinter' },
    { abi: 'event Blacklisted(address indexed _account)', category: 'freeze', toArg: '_account', freezeList: 'add' },
    { abi: 'event UnBlacklisted(address indexed _account)', category: 'freeze', toArg: '_account', freezeList: 'remove' },
    { abi: 'event BlacklisterChanged(address indexed newBlacklister)', category: 'role', toArg: 'newBlacklister' },
    { abi: 'event Pause()', category: 'pause' },
    { abi: 'event Unpause()', category: 'pause' },
    { abi: 'event PauserChanged(address indexed newAddress)', category: 'role', toArg: 'newAddress' },
    { abi: 'event OwnershipTransferred(address previousOwner, address newOwner)', category: 'role', fromArg: 'previousOwner', toArg: 'newOwner' },
    { abi: 'event RescuerChanged(address indexed newRescuer)', category: 'role', toArg: 'newRescuer' },
    { abi: 'event Upgraded(address implementation)', category: 'upgrade', toArg: 'implementation' },
    { abi: 'event AdminChanged(address previousAdmin, address newAdmin)', category: 'role', fromArg: 'previousAdmin', toArg: 'newAdmin' },
  ],
};

// Tether's TetherToken (USDT on Ethereum). Issue/Redeem/DestroyedBlackFunds change supply
// without emitting a zero-address Transfer, and a Transfer to 0x0 leaves the supply unchanged.
const TETHER: EventSet = {
  name: 'tether',
  transferToZeroBurns: false,
  events: [
    { abi: 'event Issue(uint256 amount)', category: 'issuance', supply: 'mint', amountArg: 'amount' },
    { abi: 'event Redeem(uint256 amount)', category: 'issuance', supply: 'burn', amountArg: 'amount' },
    { abi: 'event DestroyedBlackFunds(address _blackListedUser, uint256 _balance)', category: 'freeze', supply: 'burn', amountArg: '_balance', fromArg: '_blackListedUser' },
    { abi: 'event AddedBlackList(address _user)', category: 'freeze', toArg: '_user', freezeList: 'add' },
    { abi: 'event RemovedBlackList(address _user)', category: 'freeze', toArg: '_user', freezeList: 'remove' },
    { abi: 'event Deprecate(address newAddress)', category: 'upgrade', toArg: 'newAddress' },
    { abi: 'event Params(uint256 feeBasisPoints, uint256 maxFee)', category: 'config' },
    { abi: 'event Pause()', category: 'pause' },
    { abi: 'event Unpause()', category: 'pause' },
  ],
};

const EVENT_SETS = new Map<string, EventSet>([ERC20, FIATTOKEN, TETHER].map(s => [s.name, s]));

/** Names of the events that add an address to a blacklist, and that remove one, across all sets. */
export function freezeListEventNames(set?: EventSet): { add: string[]; remove: string[] } {
  const defs = (set ? [set] : [...EVENT_SETS.values()]).flatMap(s => s.events);
  const names = (kind: 'add' | 'remove') => defs.filter(d => d.freezeList === kind).map(d => eventNameOf(d.abi));
  return { add: names('add'), remove: names('remove') };
}

/** Names of the events that destroy a blacklisted address's balance (e.g. DestroyedBlackFunds). */
export function destroyedFundsEventNames(set?: EventSet): string[] {
  const defs = (set ? [set] : [...EVENT_SETS.values()]).flatMap(s => s.events);
  return defs.filter(d => d.category === 'freeze' && d.supply === 'burn').map(d => eventNameOf(d.abi));
}

function eventNameOf(abi: string): string {
  return abi.replace(/^event\s+/, '').split('(')[0].trim();
}

export function getEventSet(name: string | null | undefined): EventSet {
  const set = EVENT_SETS.get(name || 'erc20');
  if (!set) {
    throw new Error(`Unknown event set: ${name}`);
  }
  return set;
}
