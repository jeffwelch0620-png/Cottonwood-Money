// End-to-end console flows as three people (bookkeeper, controller, owner) against a freshly seeded tenant. Run via scripts/e2e-admin.sh.
const { chromium } = require('playwright');
const S = process.env.E2E_OUT ?? '/tmp';
const tokens = require(process.env.E2E_TOKENS);
const BASE = process.env.E2E_BASE ?? 'http://localhost:3100';
const assert = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); console.log('  ✓ ' + m); };
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const open = async (who, w = 1360) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
    await ctx.addInitScript((t) => sessionStorage.setItem('ledger.devToken', t), tokens[who]);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`[${who}] ${e.message}`));
    return p;
  };
  const go = async (p, path) => { await p.goto(BASE + path, { waitUntil: 'networkidle' }); await p.waitForTimeout(300); };
  const draftCard = (p, memo) => p.locator('.card .card', { hasText: memo });

  const bk = await open('bookkeeper'), ctrl = await open('controller'), owner = await open('owner');

  console.log('1. Proposer cannot approve their own draft');
  await go(bk, '/approvals');
  assert(await draftCard(bk, 'Reclass beverage comps').getByRole('button', { name: 'Approve and post' }).isDisabled(), 'bookkeeper\'s own draft: Approve disabled');

  console.log('2. Approval limit is enforced by the ledger and shown as its refusal code');
  await draftCard(bk, 'Coastal Seafood').getByRole('button', { name: 'Approve and post' }).click();
  await bk.waitForTimeout(800);
  const limitErr = await draftCard(bk, 'Coastal Seafood').locator('.error').innerText();
  assert(/APPROVAL_LIMIT/.test(limitErr), `bookkeeper (limit 2,500) approving 4,280.50 → "${limitErr.trim()}"`);

  console.log('3. Controller writes a manual entry in the form; it becomes a draft');
  await go(ctrl, '/journal/new');
  await ctrl.getByLabel('Account line 1').selectOption({ label: '7510 Repairs and maintenance' });
  await ctrl.getByLabel('Location line 1').selectOption({ label: 'Vine Ave' });
  await ctrl.getByLabel('Debit line 1').fill('640');
  await ctrl.getByLabel('Account line 2').selectOption({ label: '2120 Accrued expenses' });
  await ctrl.getByLabel('Location line 2').selectOption({ label: 'Vine Ave' });
  await ctrl.getByLabel('Credit line 2').fill('639.99');
  assert(/Out of balance by 0.01/.test(await ctrl.locator('.check').innerText()), 'form shows out of balance by 0.01 (Decimal, not floats)');
  assert(await ctrl.getByRole('button', { name: 'Submit for approval' }).isDisabled(), 'submit disabled while unbalanced');
  await ctrl.getByLabel('Credit line 2').fill('640');
  await ctrl.locator('input[placeholder="Why this entry is needed"]').fill('Accrue walk-in cooler repair');
  await ctrl.getByRole('button', { name: 'Submit for approval' }).click();
  await ctrl.waitForURL('**/approvals'); await ctrl.waitForTimeout(500);
  assert(await draftCard(ctrl, 'Accrue walk-in cooler repair').getByRole('button', { name: 'Approve and post' }).isDisabled(), 'controller cannot approve own draft');

  console.log('4. Owner approves; the entry posts with both people recorded');
  await go(owner, '/approvals');
  await draftCard(owner, 'Accrue walk-in cooler repair').getByRole('button', { name: 'Approve and post' }).click();
  await owner.waitForTimeout(800);
  assert(await draftCard(owner, 'Accrue walk-in cooler repair').count() === 0, 'draft left the queue');
  await go(owner, '/journal');
  await owner.locator('tr', { hasText: 'Accrue walk-in cooler repair' }).locator('a').first().click();
  await owner.waitForLoadState('networkidle'); await owner.waitForTimeout(300);
  const people = await owner.locator('.card', { has: owner.getByRole('heading', { name: 'People', exact: true }) }).innerText();
  assert(/Sam Ortiz/.test(people) && /Morgan Lee/.test(people), 'viewer: created by Sam Ortiz, approved by Morgan Lee');
  assert(/matches recomputed hash/.test(await owner.locator('.card', { has: owner.getByRole('heading', { name: 'Integrity', exact: true }) }).innerText()), 'viewer: hash verified');
  await owner.screenshot({ path: S + '/shots/flow-posted-entry.png', fullPage: true });

  console.log('5. Close and two-person reopen');
  await go(ctrl, '/periods');
  const oct = ctrl.locator('tr', { hasText: 'P10' });
  await oct.getByRole('button', { name: 'Hard close' }).click(); await ctrl.waitForTimeout(700);
  assert(/hard/.test(await ctrl.locator('tr', { hasText: 'P10' }).innerText()), 'October hard-closed');
  await ctrl.locator('tr', { hasText: 'P10' }).getByRole('button', { name: 'Reopen…' }).click();
  await ctrl.locator('tr', { hasText: 'P10' }).locator('input[placeholder="Reason"]').fill('Late Sysco credit memo');
  await ctrl.locator('tr', { hasText: 'P10' }).getByRole('button', { name: 'Request reopen' }).click(); await ctrl.waitForTimeout(700);
  await go(ctrl, '/approvals');
  assert(await ctrl.locator('tr', { hasText: 'Late Sysco credit memo' }).getByRole('button', { name: 'Approve' }).isDisabled(), 'requester cannot approve own reopen');
  await go(owner, '/approvals');
  await owner.locator('tr', { hasText: 'Late Sysco credit memo' }).getByRole('button', { name: 'Approve' }).click(); await owner.waitForTimeout(700);
  await go(owner, '/periods');
  assert(/open/.test(await owner.locator('tr', { hasText: 'P10' }).innerText()), 'October open again after the owner approved');
  const jun = owner.locator('tr', { hasText: 'P6' });
  assert(/sealed/.test(await jun.innerText()) && (await jun.getByRole('button').count()) === 0, 'sealed June offers no actions');

  console.log('6. Last owner cannot be demoted');
  await go(owner, '/members');
  await owner.locator('tr', { hasText: 'Morgan Lee' }).locator('select').selectOption('controller'); await owner.waitForTimeout(700);
  assert(/LAST_OWNER/.test(await owner.locator('.error').first().innerText()), 'LAST_OWNER shown');

  console.log('7. Audit export');
  await go(owner, '/audit');
  const [dl] = await Promise.all([owner.waitForEvent('download'), owner.getByRole('button', { name: 'Download JSONL' }).click()]);
  await owner.waitForTimeout(500);
  const kv = await owner.locator('.kv').innerText();
  assert(/intact/.test(kv), 'audit chain intact; file ' + dl.suggestedFilename());
  await owner.screenshot({ path: S + '/shots/flow-audit.png', fullPage: true });

  console.log('8. Bookkeeper cannot export; phone width renders');
  await go(bk, '/audit');
  assert(/Only an owner or controller/.test(await bk.locator('main').innerText()), 'bookkeeper sees no export');
  const phone = await open('controller', 390);
  await go(phone, '/reports');
  await phone.screenshot({ path: S + '/shots/phone-reports.png', fullPage: true });
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert(overflow <= 0, `no horizontal page scroll at 390px (overflow ${overflow}px)`);

  assert(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
