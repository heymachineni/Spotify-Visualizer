/** Narrow shape of `NextResponse` we need — avoids importing `next/server` in a shared util (RSC/webpack edge cases). */
type ResponseWithCookies = {
  cookies: {
    set(
      name: string,
      value: string,
      options: {
        httpOnly?: boolean;
        sameSite?: "lax" | "strict" | "none";
        path?: string;
        secure?: boolean;
        maxAge?: number;
      }
    ): void;
  };
};

/** HttpOnly cache of `GET /v1/me` right after token exchange — avoids a second `/me` hit on redirect (429 storm). */
export const SVP_ME_SNAPSHOT = "svp_me_snapshot";

export type MeSnapshotPayload = {
  id: string;
  displayName: string | null;
  product: string;
};

const secure = process.env.NODE_ENV === "production";

const baseOpts = {
  httpOnly: true as const,
  sameSite: "lax" as const,
  path: "/",
  secure,
};

export function parseMeSnapshotCookie(
  raw: string | undefined
): MeSnapshotPayload | null {
  if (!raw?.trim()) return null;
  try {
    const decoded = decodeURIComponent(raw.trim());
    const j = JSON.parse(decoded) as Partial<MeSnapshotPayload>;
    if (j?.id && typeof j.product === "string") {
      return {
        id: j.id,
        displayName:
          typeof j.displayName === "string" || j.displayName === null ?
            j.displayName
          : null,
        product: j.product,
      };
    }
  } catch {
    /* */
  }
  return null;
}

export function setMeSnapshotCookie(
  res: ResponseWithCookies,
  payload: MeSnapshotPayload,
  maxAge: number
): void {
  const dn =
    payload.displayName && payload.displayName.length > 320 ?
      `${payload.displayName.slice(0, 320)}…`
    : payload.displayName;
  const body = JSON.stringify({
    id: payload.id,
    displayName: dn,
    product: payload.product,
  });
  res.cookies.set(SVP_ME_SNAPSHOT, encodeURIComponent(body), {
    ...baseOpts,
    maxAge: Math.max(60, maxAge),
  });
}

export function clearMeSnapshotCookie(res: ResponseWithCookies): void {
  res.cookies.set(SVP_ME_SNAPSHOT, "", {
    ...baseOpts,
    maxAge: 0,
  });
}
