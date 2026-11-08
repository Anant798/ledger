import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { SharedExpensesService } from "@/lib/shared-expenses/service";
import { recordRepaymentSchema } from "@/lib/shared-expenses/validation";

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
    const validation = recordRepaymentSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: "Invalid repayment data", details: validation.error.flatten() },
        { status: 400 }
      );
    }

    const result = await SharedExpensesService.recordRepayment(
      user.id,
      validation.data
    );

    return NextResponse.json({
      message: "Repayment recorded successfully",
      ...result,
    });
  } catch (error: unknown) {
    console.error("Record repayment error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to record repayment" },
      { status: 500 }
    );
  }
}
