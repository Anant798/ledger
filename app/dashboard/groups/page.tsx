import ExpenseGroups from "@/components/expense-groups";
import PageHeading from "@/components/page-heading";

export default function GroupsPage() {
  return <div>
    <PageHeading eyebrow="SHARED COSTS" title="Group Payments" description="Keep shared costs and money people owe you in one place." hi={{ eyebrow: "साझा खर्च", title: "साझा भुगतान", description: "साझा खर्च और मिलने वाले पैसे एक जगह देखें।" }}/>
    <ExpenseGroups />
  </div>;
}
