export type Env = Readonly<Record<string, string | undefined>>;

export interface LandingConfig {
  readonly host: string;
  readonly port: number;
  /** Directory with the static page (index.html, styles, images). */
  readonly publicDir: string;
  /** JSON-lines file where demo requests are appended (on a persistent volume). */
  readonly leadsFile: string;
  /** Password of the `admin` user for /admin/leads; without it the admin pages answer 404. */
  readonly adminPassword?: string;
  /** Optional https URL that receives a JSON POST for every new request (Slack, Discord, n8n...). */
  readonly notifyUrl?: string;
  /** Shown on the privacy notice as the contact address for data requests. */
  readonly contactEmail?: string;
}

const MIN_PASSWORD = 16;

/** Parses the environment. Messages name the variable, never its value. */
export function readLandingConfig(env: Env, defaultPublicDir: string): LandingConfig {
  const port = Number(env.PORT?.trim() || '8090');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT is not a port');

  const adminPassword = env.LANDING_ADMIN_PASSWORD?.trim();
  if (adminPassword && adminPassword.length < MIN_PASSWORD)
    throw new Error(`LANDING_ADMIN_PASSWORD needs at least ${MIN_PASSWORD} characters`);

  const notifyUrl = env.LANDING_NOTIFY_URL?.trim();
  if (notifyUrl) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(notifyUrl);
    } catch {
      parsed = undefined;
    }
    if (parsed?.protocol !== 'https:') throw new Error('LANDING_NOTIFY_URL must be an https URL');
  }

  const contactEmail = env.LANDING_CONTACT_EMAIL?.trim();
  if (contactEmail && !/^[^\s@<>"']+@[^\s@<>"']+$/.test(contactEmail))
    throw new Error('LANDING_CONTACT_EMAIL is not an email address');

  return {
    host: env.HOST?.trim() || '0.0.0.0',
    port,
    publicDir: env.LANDING_PUBLIC_DIR?.trim() || defaultPublicDir,
    leadsFile: env.LANDING_LEADS_FILE?.trim() || '/data/leads.jsonl',
    ...(adminPassword ? { adminPassword } : {}),
    ...(notifyUrl ? { notifyUrl } : {}),
    ...(contactEmail ? { contactEmail } : {}),
  };
}
