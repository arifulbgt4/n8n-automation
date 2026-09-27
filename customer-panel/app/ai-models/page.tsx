import { redirect } from "next/navigation";

export default function AiModelsPage() {
  // Model/provider selection belongs to the Super Admin Panel. Keep old
  // bookmarks from exposing a confusing customer-facing configuration page.
  redirect("/");
}
