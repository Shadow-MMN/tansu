/**
 * IPFS upload client for the dApp.
 *
 * The browser never uses FILEBASE_TOKEN or PINATA_JWT directly.
 * Those credentials stay on the delegation worker, and this module
 * sends the CAR payload plus the already-signed transaction to that worker.
 */

const DUAL_PIN_TIMEOUT_MS = 120_000;
const WORKER_RETRY_DELAY_MS = 1_000;

interface DualUploadApiResponse {
  cid?: string;
  success?: boolean;
  error?: string;
}

export interface DualUploadResult {
  cid: string;
  success: boolean;
  error?: string;
}

interface UploadWithDelegationParams {
  cid: string;
  carBlob: Blob;
  signedTxXdr: string;
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function toBase64(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function postUploadRequest(
  cid: string,
  signedTxXdr: string,
  carBase64: string,
): Promise<DualUploadResult> {
  const response = await fetch(import.meta.env.PUBLIC_DELEGATION_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cid,
      signedTxXdr,
      car: carBase64,
    }),
    signal: AbortSignal.timeout(DUAL_PIN_TIMEOUT_MS),
  });

  if (!response.ok) {
    let errorMessage = "IPFS upload failed";
    try {
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const data = (await response.json()) as DualUploadApiResponse;
        errorMessage = data.error ?? errorMessage;
      } else {
        errorMessage = (await response.text()) || errorMessage;
      }
    } catch {
      // keep the default message
    }
    throw new Error(`${errorMessage} (${response.status})`);
  }

  const result = (await response.json()) as DualUploadApiResponse;
  if (!result.cid) {
    throw new Error("Dual upload response missing CID");
  }
  if (result.cid !== cid) {
    throw new Error(
      `Critical CID mismatch: expected ${cid}, got ${result.cid}`,
    );
  }
  if (!result.success) {
    throw new Error(result.error ?? "IPFS upload failed");
  }

  if (result.error) {
    console.warn("[IPFS] Upload partially succeeded:", result.error);
  }

  return {
    cid: result.cid,
    success: true,
    error: result.error,
  };
}

async function uploadWithDelegationResult({
  cid,
  carBlob,
  signedTxXdr,
}: UploadWithDelegationParams): Promise<DualUploadResult> {
  if (!cid) {
    throw new Error("Missing expected CID for dual upload");
  }

  if (!signedTxXdr) {
    throw new Error("Missing signed transaction for dual upload");
  }

  if (!(carBlob instanceof Blob) || carBlob.size === 0) {
    throw new Error("Invalid CAR blob for IPFS upload");
  }

  const carBase64 = toBase64(await carBlob.arrayBuffer());

  try {
    return await postUploadRequest(cid, signedTxXdr, carBase64);
  } catch (firstError) {
    await wait(WORKER_RETRY_DELAY_MS);

    try {
      return await postUploadRequest(cid, signedTxXdr, carBase64);
    } catch {
      throw firstError;
    }
  }
}

/**
 * Compatibility wrapper for the existing upload flow.
 * Existing callers expect only the CID after a successful dual pin.
 */
export async function uploadWithDelegation(
  params: UploadWithDelegationParams,
): Promise<string> {
  const result = await uploadWithDelegationResult(params);
  return result.cid;
}
