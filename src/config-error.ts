import { registerFields } from './error-fields.ts';

/** A configuration problem the owner fixes before rerunning: exit code 2. */
export class ConfigError extends Error {
  readonly code = 'E_CONFIG_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
    registerFields(this, { error_class: new.target.name, error_code: this.code, error_message: message });
  }
}
