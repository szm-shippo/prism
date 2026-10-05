export const LEGACY_COPILOT_CREDENTIAL_SECRET_ID = 'prism-copilot-credential';

export interface CopilotSecretStorage {
  setSecret(id: string, value: string): void;
}

export function clearLegacyCopilotCredential(secrets: CopilotSecretStorage): void {
  secrets.setSecret(LEGACY_COPILOT_CREDENTIAL_SECRET_ID, '');
}
