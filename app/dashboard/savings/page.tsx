import SavingsGoals from "@/components/savings-goals";
import PageHeading from "@/components/page-heading";

export default function SavingsPage() {
  return <div>
    <PageHeading eyebrow="PLANS FOR LATER" title="Savings Goals" description="See your goals and the money you have put aside." hi={{ eyebrow: "आगे की योजना", title: "बचत के लक्ष्य", description: "अपने लक्ष्य और अब तक बचाए पैसे देखें।" }}/>
    <SavingsGoals />
  </div>;
}
