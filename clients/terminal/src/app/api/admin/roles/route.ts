import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "../gate";

export const dynamic = "force-dynamic";

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return new NextResponse(null, { status: 404 });

  const adminApiUrl = (process.env.VEXA_ADMIN_API_URL || "").replace(/\/$/, "");
  const secret = process.env.VEXA_INTERNAL_API_SECRET || "";
  if (!adminApiUrl || !secret) {
    return NextResponse.json(
      { error: "Admin API is not configured" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const res = await fetch(`${adminApiUrl}/internal/users/roles`, {
      method: "GET",
      headers: { "X-Internal-Secret": secret, "Content-Type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.text();
    return new NextResponse(body, {
      status: res.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `admin-api unreachable: ${(err as Error).message}` },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return new NextResponse(null, { status: 404 });

  const adminApiUrl = (process.env.VEXA_ADMIN_API_URL || "").replace(/\/$/, "");
  const secret = process.env.VEXA_INTERNAL_API_SECRET || "";
  if (!adminApiUrl || !secret) {
    return NextResponse.json(
      { error: "Admin API is not configured" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const payload = await req.text();
    const res = await fetch(`${adminApiUrl}/internal/users/role`, {
      method: "POST",
      headers: { "X-Internal-Secret": secret, "Content-Type": "application/json" },
      body: payload,
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.text();
    return new NextResponse(body, {
      status: res.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `admin-api unreachable: ${(err as Error).message}` },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
