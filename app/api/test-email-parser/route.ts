
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { extractTransactionFromEmail } from "@/lib/email-parser/gemini";

export async function POST(request: Request) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const body: unknown = await request.json();

    if (
      typeof body !== "object" ||
      body === null ||
      !("emailContent" in body) ||
      typeof body.emailContent !== "string"
    ) {
      return NextResponse.json(
        { error: "emailContent must be a string." },
        { status: 400 }
      );
    }

    if (
      body.emailContent.length === 0 ||
      body.emailContent.length > 20000
    ) {
      return NextResponse.json(
        { error: "Email content must be between 1 and 20000 characters." },
        { status: 400 }
      );
    }

    const transaction = await extractTransactionFromEmail(
      body.emailContent
    );

    return NextResponse.json({ transaction });
  } catch (error) {
    console.error("Email parser error:", error);

    return NextResponse.json(
      { error: "Failed to parse email." },
      { status: 500 }
    );
  }
}
