export function createProviderRequestHeaders(
  customHeaders: Readonly<Record<string, string>>,
  apiKey: string
): Record<string, string> {
  return {
    ...customHeaders,
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
}
