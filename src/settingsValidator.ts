export interface ValidatedSettings {
  authressApiUrl: string;
  applicationId: string;
  redirectUri: string;
}

export function sanitizeUrl(rawUrlString: string): string {
  let sanitizedUrl = rawUrlString;
  if (!sanitizedUrl.startsWith('http')) {
    sanitizedUrl = `https://${sanitizedUrl}`;
  }

  const url = new URL(sanitizedUrl);
  const domainBaseUrlMatch = url.host.match(/^([a-z0-9-]+)[.][a-z0-9-]+[.]authress[.]io$/);
  if (domainBaseUrlMatch) {
    url.host = `${domainBaseUrlMatch[1]}.login.authress.io`;
    sanitizedUrl = url.toString();
  }

  return sanitizedUrl.replace(/[/]+$/, '');
}

export function validateSettings(settings: { authressApiUrl: string; applicationId: string; redirectUri: string }): ValidatedSettings {
  if (!settings.authressApiUrl) {
    throw new Error('Missing required property "authressApiUrl" in LoginClient constructor. Custom Authress Domain Host is required.');
  }

  const applicationId = settings.applicationId?.trim();
  if (!applicationId) {
    const error = Object.assign(new Error('Application ID is required.'), { code: 'InvalidApplication' });
    throw error;
  }

  if (applicationId.match(/^(sc_|ext_)/)) {
    const error = Object.assign(
      new Error(
        'You have incorrectly specified an Authress Service Client or Extension as the applicationId instead of a valid application. '
        + 'The applicationId is your application that your users will log into. '
        + 'Users cannot log into a Service Client — specify the Service Client as the connectionId instead.'
      ),
      { code: 'InvalidApplication' }
    );
    throw error;
  }

  if (!settings.redirectUri) {
    throw new Error('Missing required property "redirectUri" in LoginClient constructor.');
  }

  return {
    authressApiUrl: sanitizeUrl(settings.authressApiUrl),
    applicationId,
    redirectUri: settings.redirectUri
  };
}
