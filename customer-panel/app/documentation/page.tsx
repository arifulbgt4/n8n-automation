import Link from "next/link";

const sections = [
  {
    id: "getting-started",
    title: "1. Getting started",
    summary: "Set up your workspace in the correct order so channels, data and AI can work together.",
    steps: [
      "Create or select your organization workspace after signing in.",
      "Open Businesses and create the business you want to automate.",
      "Select that business from the business selector at the top of the panel.",
      "Connect one or more customer channels such as Facebook, Instagram or WhatsApp.",
      "Create the business data that the AI is allowed to use, then configure your AI agent and training.",
      "Test conversations before allowing the AI to handle live customer traffic.",
    ],
  },
  {
    id: "businesses",
    title: "2. Businesses",
    summary: "A single account can manage multiple independent businesses.",
    steps: [
      "Go to Businesses and choose New business.",
      "Enter the business name and a short business-type hint, such as fashion store, restaurant, salon or real estate.",
      "Set the correct timezone and currency because these values are used across business operations and reporting.",
      "Use the business selector in the header whenever you want to work with a specific business.",
    ],
  },
  {
    id: "channels",
    title: "3. Channels",
    summary: "Connect the places where customers contact your business.",
    steps: [
      "Choose a business first, then open Channels.",
      "For Facebook or Instagram, use the Meta authorization flow and select the Page/account you want to connect.",
      "For WhatsApp Business, provide the Phone Number ID, WhatsApp Business Account ID and the required access token.",
      "Use Test to verify the connection. Pause, resume, reconnect or disconnect a channel when necessary.",
      "Open channel Details when you need diagnostics such as connection state, recent inbound/outbound activity or credential metadata.",
    ],
  },
  {
    id: "catalogs",
    title: "4. Data / Catalogs",
    summary: "Store the products, services or other structured information your AI needs.",
    steps: [
      "Open Data / Catalogs and create a collection for Products, Services, Properties, Menu items, Packages or a blank custom dataset.",
      "Add custom fields such as name, price, category, stock, duration, location or any information required by your business.",
      "Mark fields as searchable, filterable, sortable and AI visible according to how they should be used.",
      "Add records manually or import multiple items as JSON. Export is available when you need a copy of the dataset.",
      "Link each collection only to the channels that are allowed to use that data.",
    ],
  },
  {
    id: "conversations",
    title: "5. Conversations",
    summary: "Review customer messages and control AI/human handoff from one inbox.",
    steps: [
      "Open Conversations to see customer threads for the selected business.",
      "Open a thread to review the message history and current handling mode.",
      "Take over a conversation when a human response is required, then return it to AI mode when appropriate.",
      "Use conversation history as a source for future training examples when you identify a useful customer interaction.",
    ],
  },
  {
    id: "actions",
    title: "6. Business Actions",
    summary: "Track outcomes created from conversations, such as orders, bookings and leads.",
    steps: [
      "Open Business Actions to review operational outcomes produced by customer conversations.",
      "Confirm important customer details before treating an AI-created action as final.",
      "Use the selected business scope to avoid mixing actions from separate businesses.",
    ],
  },
  {
    id: "ai-agents",
    title: "7. AI Agents",
    summary: "Configure how the AI represents each business and channel.",
    steps: [
      "Create or select an AI agent for the current business.",
      "Define its role, instructions and the business behavior it should follow.",
      "Attach the agent to the appropriate business/channel scope instead of using one generic prompt everywhere.",
      "Keep instructions explicit about tone, escalation, data usage, unsupported requests and when a human should take over.",
      "Test changes before publishing them to active customer traffic.",
    ],
  },
  {
    id: "training",
    title: "8. Training",
    summary: "Teach the AI from real examples and improve its response behavior over time.",
    steps: [
      "Use Training to add example conversations or reusable training material for the selected business.",
      "Prefer examples that show the exact response style and business rules you want the AI to follow.",
      "Review generated or edited training instructions before publishing a new version.",
      "Update training when products, policies, delivery rules, prices or business procedures change.",
    ],
  },
  {
    id: "knowledge",
    title: "9. Knowledge",
    summary: "Provide longer-form reference information that complements structured catalog data.",
    steps: [
      "Add policies, FAQs, service details, operating rules and other reference documents under Knowledge.",
      "Keep frequently changing values such as stock or prices in Data / Catalogs instead of burying them in long documents.",
      "Review knowledge regularly so the AI does not rely on outdated business information.",
    ],
  },
  {
    id: "media",
    title: "10. Media",
    summary: "Manage reusable business files and media assets.",
    steps: [
      "Use Media for files that need to be stored or reused by the business.",
      "Keep file names descriptive so team members can identify the correct asset quickly.",
      "Remove obsolete assets when they should no longer be used in customer communication.",
    ],
  },
  {
    id: "analytics",
    title: "11. Analytics",
    summary: "Measure transport usage, AI work and business outcomes separately.",
    steps: [
      "Use Dashboard for a quick business pulse and Analytics for deeper usage information.",
      "Review inbound messages, outbound messages and AI calls as separate metrics.",
      "Compare open conversations and business outcomes such as orders, bookings or leads.",
      "Always confirm the selected workspace and business before interpreting the numbers.",
    ],
  },
  {
    id: "team",
    title: "12. Team & access",
    summary: "Invite staff and control which businesses each user can access.",
    steps: [
      "Open Team and invite a member by email.",
      "Assign the minimum role required for that person: Admin, Staff or Viewer.",
      "Optionally restrict non-owner users to selected businesses; leaving the scope unrestricted allows access to all permitted businesses.",
      "Suspend access when a teammate should temporarily stop using the workspace, and revoke unused invitations when necessary.",
    ],
  },
  {
    id: "settings",
    title: "13. Settings",
    summary: "Manage organization settings, retention, quotas and operational policies.",
    steps: [
      "Keep the organization name and business-level information current.",
      "Review retention settings before changing how long conversation, media, audit or training data is kept.",
      "Configure quota alerts so usage limits do not surprise your team.",
      "Use follow-up policies only when they match your customer communication rules and channel requirements.",
      "Treat account deletion and data-management actions as destructive operations and verify them carefully before confirming.",
    ],
  },
];

const checklist = [
  "Business created and selected",
  "At least one channel connected and tested",
  "Catalog/service data added and linked to the correct channel",
  "AI agent instructions reviewed",
  "Training and knowledge added",
  "A test conversation completed",
  "Human handoff tested",
  "Team permissions reviewed",
  "Analytics checked after test traffic",
];

export const metadata = {
  title: "Customer Documentation | Automation SaaS",
  description: "Customer guide for setting up and using the Automation SaaS customer panel.",
};

export default function DocumentationPage() {
  return (
    <main className="docs-page">
      <style>{`
        .docs-page{min-height:100vh;background:#f7f8fb;color:#171a21;padding:32px 20px 72px}.docs-wrap{max-width:1180px;margin:0 auto}.docs-top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:28px}.docs-brand{display:flex;align-items:center;gap:12px}.docs-logo{width:38px;height:38px;border-radius:12px;background:#111827;color:#fff;display:grid;place-items:center;font-weight:800}.docs-back{display:inline-flex;align-items:center;gap:8px;text-decoration:none;color:#252936;border:1px solid #dfe3ea;background:#fff;padding:10px 14px;border-radius:10px;font-weight:650}.docs-hero{background:linear-gradient(135deg,#111827,#29354f);color:#fff;padding:40px;border-radius:24px;margin-bottom:24px;box-shadow:0 18px 45px rgba(20,28,45,.12)}.docs-kicker{font-size:13px;text-transform:uppercase;letter-spacing:.12em;opacity:.72;font-weight:700}.docs-hero h1{font-size:clamp(32px,5vw,54px);line-height:1.02;margin:10px 0 14px}.docs-hero p{max-width:760px;font-size:17px;line-height:1.7;color:#dbe2ef;margin:0}.docs-grid{display:grid;grid-template-columns:260px minmax(0,1fr);gap:24px;align-items:start}.docs-nav{position:sticky;top:20px;background:#fff;border:1px solid #e3e6ec;border-radius:16px;padding:14px}.docs-nav strong{display:block;padding:8px 10px 10px;font-size:14px}.docs-nav a{display:block;padding:8px 10px;border-radius:8px;color:#555d6d;text-decoration:none;font-size:14px}.docs-nav a:hover{background:#f3f5f8;color:#111827}.docs-content{display:grid;gap:16px}.docs-card{background:#fff;border:1px solid #e3e6ec;border-radius:18px;padding:24px;scroll-margin-top:24px}.docs-card h2{font-size:22px;margin:0 0 8px}.docs-card p{margin:0 0 15px;color:#687083;line-height:1.65}.docs-card ol{margin:0;padding-left:22px;display:grid;gap:10px;color:#303643;line-height:1.6}.docs-card li::marker{font-weight:700}.docs-check{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:16px}.docs-check div{border:1px solid #e6e9ef;border-radius:12px;padding:13px;background:#fafbfc;font-size:14px}.docs-note{border-left:4px solid #111827;padding:14px 16px;background:#f3f5f8;border-radius:0 12px 12px 0;color:#424958;line-height:1.6}.docs-footer{margin-top:24px;color:#747b89;font-size:13px;text-align:center}.docs-anchor{color:inherit}@media(max-width:820px){.docs-page{padding:18px 14px 52px}.docs-top{align-items:flex-start}.docs-hero{padding:28px 22px;border-radius:18px}.docs-grid{grid-template-columns:1fr}.docs-nav{position:static}.docs-nav-links{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.docs-check{grid-template-columns:1fr}}@media(max-width:520px){.docs-top{flex-direction:column}.docs-nav-links{grid-template-columns:1fr}.docs-back{width:100%;justify-content:center}}
      `}</style>

      <div className="docs-wrap">
        <div className="docs-top">
          <div className="docs-brand">
            <div className="docs-logo">A</div>
            <div><strong>Automation SaaS</strong><div style={{fontSize:13,color:"#737b8a"}}>Customer documentation</div></div>
          </div>
          <Link className="docs-back" href="/">← Back to customer panel</Link>
        </div>

        <section className="docs-hero">
          <div className="docs-kicker">Customer guide</div>
          <h1>Set up, train and operate your automation workspace.</h1>
          <p>This guide explains the recommended setup order and the purpose of every major section in the customer panel. Start with a business, connect customer channels, add trusted business data, configure the AI, then test before going live.</p>
        </section>

        <div className="docs-grid">
          <aside className="docs-nav">
            <strong>On this page</strong>
            <div className="docs-nav-links">
              {sections.map((section) => <a key={section.id} href={`#${section.id}`}>{section.title.replace(/^\d+\.\s*/, "")}</a>)}
              <a href="#launch-checklist">Launch checklist</a>
              <a href="#troubleshooting">Troubleshooting</a>
            </div>
          </aside>

          <div className="docs-content">
            {sections.map((section) => (
              <section className="docs-card" id={section.id} key={section.id}>
                <h2><a className="docs-anchor" href={`#${section.id}`}>{section.title}</a></h2>
                <p>{section.summary}</p>
                <ol>{section.steps.map((step) => <li key={step}>{step}</li>)}</ol>
              </section>
            ))}

            <section className="docs-card" id="launch-checklist">
              <h2>Launch checklist</h2>
              <p>Complete these checks before relying on the automation for live customer conversations.</p>
              <div className="docs-check">{checklist.map((item) => <div key={item}>✓ {item}</div>)}</div>
            </section>

            <section className="docs-card" id="troubleshooting">
              <h2>Troubleshooting</h2>
              <p>Use these checks when something does not behave as expected.</p>
              <ol>
                <li>Confirm the correct organization and business are selected in the top bar.</li>
                <li>If messages are not arriving, open Channels, run Test and inspect channel Details/diagnostics.</li>
                <li>If the AI cannot answer a business question, confirm the correct catalog is linked to the channel and the required fields are AI visible.</li>
                <li>If the AI answer is behaviorally wrong, update the Agent instructions or Training examples rather than duplicating product data inside the prompt.</li>
                <li>If a teammate cannot access a business, review Team role and business scope.</li>
                <li>If usage looks unexpected, compare Dashboard/Analytics metrics by the same selected business and time scope.</li>
              </ol>
            </section>

            <div className="docs-note"><strong>Recommended practice:</strong> test every important flow with a real test conversation after changing channels, data, agent instructions, training or knowledge. Business data and AI behavior should be reviewed whenever your products, services, prices, policies or operating procedures change.</div>
          </div>
        </div>

        <div className="docs-footer">Automation SaaS · Customer Panel Documentation</div>
      </div>
    </main>
  );
}
