import GmailBankAlerts from "@/components/gmail-bank-alerts";
import Transactions from "@/components/transactions";
import PageHeading from "@/components/page-heading";

export default function BankingPage() {
  return <div>
    <PageHeading eyebrow="BANK RECORDS" title="Money In & Out" description="See your bank activity and keep your own records up to date." hi={{ eyebrow: "बैंक का हिसाब", title: "पैसे आए और गए", description: "बैंक के लेन-देन देखें और अपना हिसाब अपडेट रखें।" }}/>
    <Transactions />
    <GmailBankAlerts />
  </div>;
}
