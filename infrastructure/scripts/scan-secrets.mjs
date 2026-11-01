#!/usr/bin/env node
// Secret scan of the whole Git history and the files tracked now (npm run security:secrets).
// Exits 1 when something that looks like a real credential is found. Not a replacement for a dedicated scanner
// (gitleaks, trufflehog) in CI, but needs nothing installed and runs before every push.
import { execFileSync } from 'node:child_process';

const RULES = [
  ['private key', /-----BEGIN (RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ['AWS access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['OpenAI/Anthropic-style key', /\bsk-(ant-)?[A-Za-z0-9_-]{24,}\b/],
  ['Azure connection string', /AccountKey=[A-Za-z0-9+/=]{40,}/],
  ['SendGrid key', /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/],
  ['database URL with a password', /\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis):\/\/[^\s:@/'"]+:[^\s@/'"]{6,}@(?!(localhost|127\.0\.0\.1|postgres|redis)[:/])/],
  ['assigned secret in an env file', /^\+?\s*(APP_ENCRYPTION_KEY|PLATFORM_BOOTSTRAP_KEY|JWT_PRIVATE_KEY_PEM|JUDGE_TOKEN|SMTP_PASS(WORD)?|[A-Z_]*CLIENT_SECRET)\s*=\s*\S{8,}/],
];
// Known fake values used by tests and the demo: never real credentials.
const ALLOW = [/Demo-(Admin|Staff|Student)!2026/, /test-platform-bootstrap-key/, /examos_app:examos_app@/, /postgres:postgres@/];

const run = (args) => execFileSync('git', args, { maxBuffer: 1 << 30 }).toString();
const findings = [];
function scan(text, where) {
  let file = '';
  let commit = where;
  for (const line of text.split('\n')) {
    if (line.startsWith('commit ')) commit = line.slice(7, 19);
    else if (line.startsWith('+++ b/')) file = line.slice(6);
    if (where === 'history' && !line.startsWith('+')) continue;
    if (ALLOW.some((a) => a.test(line))) continue;
    for (const [name, re] of RULES) if (re.test(line)) findings.push(`${name}: ${commit} ${file} :: ${line.trim().slice(0, 120)}`);
  }
}
scan(run(['log', '--all', '-p', '--no-color', '--no-ext-diff']), 'history');
for (const f of run(['ls-files']).split('\n').filter(Boolean)) {
  if (/(^|\/)\.env($|\.)/.test(f) && f !== '.env.example') findings.push(`tracked env file: ${f}`);
}
if (findings.length) {
  console.error(`Possible secrets (${findings.length}). Rotate any real one, then remove it from history:\n${[...new Set(findings)].join('\n')}`);
  process.exit(1);
}
console.log('No secrets found in Git history or tracked files.');
