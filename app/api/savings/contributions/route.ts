import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { SavingsService } from "@/lib/savings/service";
import { addContributionSchema } from "@/lib/savings/validation";

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
    const validation = addContributionSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: "Invalid contribution data", details: validation.error.flatten() },
        { status: 400 }
      );
    }

    const contribution = await SavingsService.addManualContribution(
      user.id,
      validation.data
    );

    return NextResponse.json(
      {
        message: "Contribution recorded successfully",
        contribution,
      },
      { status: 201 }
    );
  } catch (error: any) {
    console.error("Add contribution error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to add contribution" },
      { status: 500 }
    );
  }
}
