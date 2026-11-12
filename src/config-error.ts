/** A configuration problem the owner fixes before rerunning: exit code 2. */
export class ConfigError extends Error {
  readonly code = 'E_CONFIG_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
