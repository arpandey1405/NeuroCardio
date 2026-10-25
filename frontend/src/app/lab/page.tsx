import type { Metadata } from "next";
import { LabView } from "@/components/lab-view";

export const metadata: Metadata = { title: "Classifier lab" };

export default function LabPage() {
  return <LabView />;
}
