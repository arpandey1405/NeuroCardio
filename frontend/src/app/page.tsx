import type { Metadata } from "next";
import { Controls } from "@/components/monitor/controls";
import { EcgStrip } from "@/components/monitor/ecg-strip";
import { Kpis } from "@/components/monitor/kpis";
import { BeatLog, EventLog, Morphology, Trends } from "@/components/monitor/panels";
import { SnnActivity } from "@/components/monitor/snn-activity";

export const metadata: Metadata = { title: "Live monitor" };

export default function MonitorPage() {
  return (
    <div className="flex flex-col gap-5">
      <Kpis />
      <EcgStrip />
      <SnnActivity />
      <div className="grid gap-5 lg:grid-cols-2">
        <Morphology />
        <Trends />
      </div>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(340px,1fr)]">
        <BeatLog />
        <div className="flex min-w-0 flex-col gap-5">
          <Controls />
          <EventLog />
        </div>
      </div>
    </div>
  );
}
