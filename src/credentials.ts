// The run's model credentials. They live only in this process: the proxy adds them to each request, and the agents
// get a placeholder.

export interface FederationSettings {
  ruleId: string;
  organizationId: string;
  serviceAccountId: string;
  workspaceId: string;
}

// Exchanges a fresh GitHub OIDC token for an Anthropic access token, and renews it two minutes before it expires.
// GitHub's tokens last about five minutes and work once, so every exchange asks GitHub for a new one.
export class AnthropicTokenSource {
  #settings: FederationSettings;
  #requestUrl: string;
  #requestToken: string;
  #token: string | undefined;
  #expiresAt = 0;
  #pending: Promise<string> | undefined;
  readonly secrets = new Set<string>();

  constructor(settings: FederationSettings, requestUrl: string, requestToken: string) {
    this.#settings = settings;
    this.#requestUrl = requestUrl;
    this.#requestToken = requestToken;
  }

  async token(): Promise<string> {
    if (this.#token && Date.now() < this.#expiresAt - 120_000) return this.#token;
    this.#pending ??= this.#exchange().finally(() => (this.#pending = undefined));
    return this.#pending;
  }

  async #exchange(): Promise<string> {
    const oidc = await fetch(`${this.#requestUrl}&audience=${encodeURIComponent('https://api.anthropic.com')}`, {
      headers: { authorization: `Bearer ${this.#requestToken}` },
    });
    if (!oidc.ok) throw new Error(`GitHub refused an OIDC token: HTTP ${oidc.status}`);
    const jwt = ((await oidc.json()) as { value: string }).value;
    this.secrets.add(jwt);

    const response = await fetch('https://api.anthropic.com/v1/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
        federation_rule_id: this.#settings.ruleId,
        organization_id: this.#settings.organizationId,
        service_account_id: this.#settings.serviceAccountId,
        workspace_id: this.#settings.workspaceId,
      }),
    });
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!response.ok || !body.access_token) {
      throw new Error(`Anthropic refused the federated login: HTTP ${response.status}. The Console's authentication events say why.`);
    }
    this.#token = body.access_token;
    this.#expiresAt = Date.now() + (body.expires_in ?? 300) * 1000;
    this.secrets.add(body.access_token);
    return body.access_token;
  }
}

export interface Credentials {
  anthropic?: AnthropicTokenSource;
  bedrockKey?: string;
}

// Every secret value this run has held, for the output scan.
export function secretValues(credentials: Credentials): string[] {
  return [...(credentials.anthropic?.secrets ?? []), ...(credentials.bedrockKey ? [credentials.bedrockKey] : [])];
}
