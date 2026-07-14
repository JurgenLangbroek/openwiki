export function createGatewayUnavailableWarning(connectorName: string): string {
  return `${connectorName} gateway tooling is unavailable for this tenant; gateway reads are disabled for this run.`;
}

export function getMcpErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isMcpEndpointUnavailableError(error: unknown): boolean {
  const status =
    error instanceof Error && "status" in error
      ? (error as Error & { status?: unknown }).status
      : undefined;
  if (status === 404 || status === 405 || status === 501) {
    return true;
  }

  const message = getMcpErrorMessage(error);
  return /(?:MCP HTTP request failed:\s*(?:404|405|501)|method not found)/iu.test(
    message,
  );
}
