// Dev only: mint an access token the API accepts, for the admin console's dev sign-in.
// Usage: SUPABASE_JWT_SECRET=... npm run dev:token -- <auth_user_id> [tenant_id] [aal1|aal2]
import { SignJWT } from 'jose';

const [sub, tenant, aal = 'aal2'] = process.argv.slice(2);
const secret = process.env.SUPABASE_JWT_SECRET;
if (!sub || !secret) {
  console.error('usage: SUPABASE_JWT_SECRET=... npm run dev:token -- <auth_user_id> [tenant_id] [aal1|aal2]');
  process.exit(1);
}
console.log(await mint(sub, tenant, aal, secret));

export async function mint(sub: string, tenant: string | undefined, aal: string, secret: string) {
  return new SignJWT({ aal, role: 'authenticated', ...(tenant ? { tenant_id: tenant } : {}) })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(sub).setAudience('authenticated')
    .setIssuedAt().setExpirationTime('12h').sign(new TextEncoder().encode(secret));
}
