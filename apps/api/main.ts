// Entrypoint: DATABASE_URL, SUPABASE_JWT_SECRET (HS256) or SUPABASE_JWKS_URL, optional PORT,
// JWT_ISSUER, JWT_AUDIENCE, DB_ROLE.
import pg from 'pg';
import { buildServer } from './server.js';

const env = (k: string) => process.env[k] || undefined;
const pool = new pg.Pool({ connectionString: env('DATABASE_URL') ?? (() => { throw new Error('DATABASE_URL is required'); })() });
const app = await buildServer({
  pool,
  jwtSecret: env('SUPABASE_JWT_SECRET'),
  jwksUrl: env('SUPABASE_JWKS_URL'),
  issuer: env('JWT_ISSUER'),
  audience: env('JWT_AUDIENCE') ?? 'authenticated',
  dbRole: env('DB_ROLE') ?? 'app_role',
  logger: true,
});
await app.listen({ port: Number(env('PORT') ?? 3000), host: '0.0.0.0' });
