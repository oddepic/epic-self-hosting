import { NextRequest, NextResponse } from "next/server";
import { guardMutatingRequest } from "./lib/middleware/origin-guard";

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const decision = guardMutatingRequest({
    method: request.method,
    pathname,
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
  });
  if (decision === "allow") return NextResponse.next();
  return NextResponse.json({ error: "forbidden" }, { status: 403 });
}

export const config = {
  matcher: ["/api/:path*"],
};
