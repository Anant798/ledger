import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { queryFinancialAssistant } from "@/lib/assistant/service";
import { z } from "zod";

const querySchema = z.object({
  query: z.string().min(1).max(1000),
  conversationId: z.string().uuid().optional(),
});

export async function POST(request: Request) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const validation = querySchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: "Invalid question query", details: validation.error.flatten() },
        { status: 400 }
      );
    }

    const result = await queryFinancialAssistant(
      user.id,
      validation.data.query,
      validation.data.conversationId
    );

    return NextResponse.json(result);
  } catch (error: any) {
    console.error("AI Assistant query error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to process question with financial assistant" },
      { status: 500 }
    );
  }
}
