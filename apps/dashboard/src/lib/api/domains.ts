import { ApiError, api } from "./client";
import { endpoints } from "./endpoints";

export interface DomainVerifyResult {
  verified: boolean;
  cnameVerified?: boolean;
  txtVerified?: boolean;
  message?: string;
  sslStatus?: string;
}

export interface DomainSslVerifyResult {
  domain: string;
  sslStatus: string;
  expiresAt?: string | null;
  issuer?: string | null;
  verified: boolean;
}

export const domainsApi = {
  /** Get DNS records preview for a hostname (no domain creation needed). */
  previewRecords: (hostname: string) =>
    api.post<{
      data: {
        mode: "cloud" | "selfhosted";
        records: Array<{ type: "CNAME" | "A" | "TXT"; host: string; value: string }>;
      };
    }>(endpoints.domains.preview, { hostname }),

  /**
   * Re-run DNS verification for a domain.
   *
   * Returns the verify result on BOTH success and failure — the backend
   * returns 422 with the same shape when verification fails so the UI
   * can surface cnameVerified/txtVerified/message inline without a
   * second request. Any error other than 422 (network, 4xx, 5xx) is
   * re-thrown so callers can show a generic failure toast.
   */
  verify: async (domainId: string): Promise<DomainVerifyResult> => {
    try {
      return await api.post<DomainVerifyResult>(endpoints.domains.verify(domainId));
    } catch (err) {
      if (err instanceof ApiError && err.status === 422 && err.body && typeof err.body === "object") {
        return err.body as DomainVerifyResult;
      }
      throw err;
    }
  },

  /**
   * Recheck SSL: read-only verification that the Let's Encrypt cert is actually
   * issued + valid on the serving host. No certbot / rate-limit cost. Recovers a
   * domain stuck in "provisioning" once its cert is in place.
   */
  verifySsl: (domainId: string) =>
    api.post<{ data: DomainSslVerifyResult }>(endpoints.domains.verifySsl(domainId)),

  /** Make this domain the project's primary (canonical) hostname. Unsets any
   *  prior primary; exactly one row stays primary per project. */
  setPrimary: (domainId: string) =>
    api.post<{ data: { id: string; hostname: string; isPrimary: boolean } }>(
      endpoints.domains.primary(domainId),
    ),
};
