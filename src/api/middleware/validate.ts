import type { Request, Response, NextFunction } from 'express';
import type { ZodSchema } from 'zod';

export function validate(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: 'Invalid request body',
        issues: result.error.issues.map((i) => ({
          path:    i.path.join('.'),
          message: i.message,
        })),
      });
      return;
    }
    req.body = result.data;
    next();
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Use as router.param('id', validateUUIDParam) to reject non-UUID session IDs
// at the router boundary before any handler or DB call runs.
export function validateUUIDParam(
  _req: Request,
  res: Response,
  next: NextFunction,
  value: string,
): void {
  if (!UUID_RE.test(value)) {
    res.status(400).json({ error: 'Invalid ID — expected a UUID' });
    return;
  }
  next();
}
