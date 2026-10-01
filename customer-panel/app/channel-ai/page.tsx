import { redirect } from "next/navigation";

export default function LegacyChannelAiRoute() {
  redirect("/?view=agents");
}
