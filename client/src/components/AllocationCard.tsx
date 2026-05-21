import { useState } from "react";
import type { Currency } from "@choopi/shared";
import { Card } from "./Card";
import { Segment } from "./Segment";
import { Donut } from "./Donut";

interface AllocSlice {
  label: string;
  value: number;
  color: string;
}

interface AllocationCardProps {
  byType: AllocSlice[];
  byCurrency: AllocSlice[];
  currency: Currency;
}

type Tab = "type" | "currency";
const TABS = [
  { value: "type" as Tab, label: "By Type" },
  { value: "currency" as Tab, label: "By Currency" },
];

export function AllocationCard({ byType, byCurrency, currency }: AllocationCardProps) {
  const [tab, setTab] = useState<Tab>("type");
  const data = tab === "type" ? byType : byCurrency;

  return (
    <Card pad={false} className="cf-alloc">
      <div className="cf-card-head">
        <div>
          <div className="cf-card-title">Allocation</div>
        </div>
        <Segment options={TABS} value={tab} onChange={setTab} size="sm" />
      </div>
      <Donut data={data} currency={currency} />
    </Card>
  );
}
