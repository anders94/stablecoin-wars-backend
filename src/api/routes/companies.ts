import { Router, Request, Response } from 'express';
import { query, queryOne, execute } from '../../db';
import { Company, CreateCompanyRequest } from '../../types';

const router = Router();

// List all companies
router.get('/', async (_req: Request, res: Response) => {
  try {
    const companies = await query<Company>(
      'SELECT * FROM companies ORDER BY name'
    );
    res.json(companies);
  } catch (error) {
    console.error('Error fetching companies:', error);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

// Get company by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const company = await queryOne<Company>(
      'SELECT * FROM companies WHERE id = $1',
      [req.params.id]
    );
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }
    res.json(company);
  } catch (error) {
    console.error('Error fetching company:', error);
    res.status(500).json({ error: 'Failed to fetch company' });
  }
});

// Create company
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, website } = req.body as CreateCompanyRequest;

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const company = await queryOne<Company>(
      `INSERT INTO companies (name, website)
       VALUES ($1, $2)
       RETURNING *`,
      [name, website || null]
    );
    res.status(201).json(company);
  } catch (error: unknown) {
    console.error('Error creating company:', error);
    if ((error as { code?: string }).code === '23505') {
      return res.status(409).json({ error: 'Company already exists' });
    }
    res.status(500).json({ error: 'Failed to create company' });
  }
});

// Update company
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { name, website } = req.body;
    const company = await queryOne<Company>(
      `UPDATE companies
       SET name = COALESCE($1, name), website = COALESCE($2, website)
       WHERE id = $3
       RETURNING *`,
      [name, website, req.params.id]
    );
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }
    res.json(company);
  } catch (error) {
    console.error('Error updating company:', error);
    res.status(500).json({ error: 'Failed to update company' });
  }
});

// Delete company
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const count = await execute(
      'DELETE FROM companies WHERE id = $1',
      [req.params.id]
    );
    if (count === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting company:', error);
    res.status(500).json({ error: 'Failed to delete company' });
  }
});

export default router;
