// The stylesheet the landing page and /docs share, moved out of the landing
// route so both pages render with the same look.
export const PAGE_STYLES = `
    :root {
      --green: #27C58B;
      --dark: #07241B;
      --mint: #D0FBCB;
      --off: #F9F7F6;
      --yellow: #FFF140;
      --pink: #FF7FAF;
      --orange: #FF7640;
      --violet: #A3A9FF;
      color-scheme: dark;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      background: var(--dark); color: var(--off);
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      font-size: 17px; line-height: 1.55;
      -webkit-font-smoothing: antialiased;
    }
    h1, h2, h3, h4 {
      font-family: 'Bricolage Grotesque', 'Inter', sans-serif;
      font-weight: 800; letter-spacing: -0.02em; line-height: 1.05;
    }
    .container { max-width: 960px; margin: 0 auto; padding: 0 clamp(20px, 4vw, 32px); }

    /* Top brand bar */
    .topbar {
      display: flex; justify-content: space-between; align-items: center;
      padding: 24px 0; gap: 16px; flex-wrap: wrap;
    }
    .brand {
      display: inline-flex; align-items: center; gap: 12px;
      color: var(--off);
      font-family: 'Bricolage Grotesque', sans-serif; font-weight: 800; font-size: 1.3rem;
      text-decoration: none;
    }
    .logomark {
      width: 26px; height: 26px; border-radius: 50%;
      background: var(--green); border: 2px solid var(--off);
      position: relative; display: inline-block;
    }
    .logomark::after {
      content: ""; position: absolute; inset: 5px;
      background: var(--dark); border-radius: 50%;
    }
    .nav-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: flex-end; }
    .nav-link {
      font-size: 0.92rem; color: var(--mint);
      border-bottom: 1.5px solid rgba(208, 251, 203, 0.4); padding-bottom: 1px;
      text-decoration: none;
    }
    .nav-link:hover { color: var(--green); border-bottom-color: var(--green); }

    /* Hero */
    .hero { padding: 32px 0 24px; text-align: left; }
    .hero h1 {
      font-size: clamp(2.2rem, 6vw, 3.8rem);
      color: var(--off); max-width: 18ch; margin-bottom: 18px;
    }
    .hero h1 .punct { color: var(--green); }
    .hero .subtitle {
      max-width: 60ch; color: var(--mint);
      font-size: 1.05rem; line-height: 1.5; margin-bottom: 1.5rem;
    }
    .hero .subtitle a { color: var(--off); border-bottom: 1.5px solid rgba(249, 247, 246, 0.35); padding-bottom: 1px; text-decoration: none; }
    .hero .subtitle a:hover { color: var(--green); border-bottom-color: var(--green); }
    .hero .subtitle code { color: var(--off); background: rgba(249, 247, 246, 0.12); }
    .hero .cta-row { display: flex; gap: 12px; justify-content: flex-start; flex-wrap: wrap; margin-top: 4px; }

    /* Buttons */
    .btn {
      display: inline-flex; align-items: center; justify-content: center;
      min-height: 44px; padding: 10px 18px; border-radius: 999px;
      font-family: 'Bricolage Grotesque', sans-serif;
      font-size: 0.96rem; font-weight: 800; line-height: 1;
      text-decoration: none; cursor: pointer;
      border: 2px solid transparent;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
    .btn-primary { background: var(--green); color: var(--dark); border-color: var(--green); }
    .btn-primary:hover { transform: translate(-2px, -2px); box-shadow: 4px 4px 0 var(--off); text-decoration: none; }
    .btn-outline { background: transparent; color: var(--mint); border-color: rgba(208, 251, 203, 0.4); }
    .btn-outline:hover { color: var(--off); border-color: var(--mint); transform: translate(-2px, -2px); box-shadow: 4px 4px 0 var(--green); text-decoration: none; }

    /* Value props */
    .value-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 14px; margin: 2rem 0;
    }
    .value-card {
      background: var(--off); color: var(--dark);
      border: 2px solid var(--dark); border-radius: 22px; padding: 22px;
      box-shadow: 6px 6px 0 var(--green);
    }
    .value-card .icon { font-size: 2rem; margin-bottom: 0.75rem; }
    .value-card h3 { font-size: 1.15rem; color: var(--dark); margin-bottom: 0.5rem; }
    .value-card p { font-size: 0.95rem; color: rgba(7, 36, 27, 0.78); margin: 0; line-height: 1.5; }

    /* How it works */
    .steps {
      display: grid; grid-template-columns: repeat(4, 1fr);
      gap: 16px; margin: 1.25rem 0;
    }
    @media (max-width: 820px) {
      .steps { grid-template-columns: repeat(2, 1fr); }
    }
    @media (max-width: 460px) {
      .steps { grid-template-columns: 1fr; }
    }
    .step {
      padding: 16px;
      border: 2px solid rgba(7, 36, 27, 0.12);
      border-radius: 16px;
      background: rgba(208, 251, 203, 0.35);
    }
    .step-number {
      display: inline-flex; align-items: center; justify-content: center;
      width: 36px; height: 36px; border-radius: 50%;
      background: var(--dark); color: var(--mint);
      font-family: 'Bricolage Grotesque', sans-serif; font-weight: 800; font-size: 1.05rem;
      margin-bottom: 0.75rem;
    }
    .step h4 { color: var(--dark); margin-bottom: 6px; font-size: 1rem; }
    .step p { color: rgba(7, 36, 27, 0.78); font-size: 0.9rem; margin: 0; line-height: 1.45; }
    .step a { color: var(--dark); border-bottom: 1.5px solid rgba(7, 36, 27, 0.4); padding-bottom: 1px; text-decoration: none; font-weight: 600; }
    .step a:hover { border-bottom-color: var(--green); }

    /* Platform pills */
    .platform-grid {
      display: flex; flex-wrap: wrap; gap: 10px; justify-content: center;
      margin: 1.5rem auto;
      max-width: 640px;
    }
    .platform-pill {
      display: inline-flex; align-items: center; gap: 0.5rem;
      background: var(--off); color: var(--dark);
      border: 2px solid var(--dark); border-radius: 999px;
      padding: 8px 14px; font-size: 0.92rem; font-weight: 600;
      box-shadow: 3px 3px 0 var(--green);
      text-decoration: none; cursor: pointer;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
    .platform-pill:hover { transform: translate(-2px, -2px); box-shadow: 5px 5px 0 var(--green); }
    .platform-pill:focus-visible { outline: 3px solid var(--yellow); outline-offset: 2px; }
    .platform-pill svg { width: 18px; height: 18px; flex-shrink: 0; fill: var(--dark); }

    /* Sections (cards) */
    section {
      background: var(--off); color: var(--dark);
      border: 2px solid var(--dark); border-radius: 22px;
      padding: 24px; margin-bottom: 18px;
      box-shadow: 6px 6px 0 var(--green);
    }
    section h2 {
      font-size: 1.45rem; color: var(--dark);
      margin-bottom: 0.85rem; padding-bottom: 0.5rem;
      border-bottom: 2px solid rgba(7, 36, 27, 0.12);
    }
    section h3 { font-size: 1.05rem; color: var(--dark); margin: 1.25rem 0 0.5rem; }
    section h4 { font-size: 0.95rem; color: rgba(7, 36, 27, 0.78); margin: 0.75rem 0 0.25rem; }
    section p { margin-bottom: 0.55rem; color: rgba(7, 36, 27, 0.78); font-size: 0.95rem; line-height: 1.5; }
    section ul { margin: 0.4rem 0 0.6rem 1.25rem; color: rgba(7, 36, 27, 0.78); font-size: 0.95rem; }
    section li { margin-bottom: 0.25rem; }
    section a { color: var(--dark); border-bottom: 1.5px solid rgba(7, 36, 27, 0.4); padding-bottom: 1px; text-decoration: none; font-weight: 600; }
    section a:hover { border-bottom-color: var(--green); color: var(--dark); }
    section strong { color: var(--dark); }

    code {
      background: rgba(7, 36, 27, 0.08); color: var(--dark);
      padding: 1px 6px; border-radius: 6px;
      font-size: 0.88em; font-family: 'SF Mono', Menlo, Consolas, monospace;
    }
    pre {
      background: var(--dark); color: var(--mint);
      padding: 1rem; border-radius: 14px;
      overflow-x: auto; font-size: 0.82rem; margin: 0.5rem 0 0.75rem;
      font-family: 'SF Mono', Menlo, Consolas, monospace; line-height: 1.5;
      border: 2px solid var(--dark);
    }
    pre .comment { color: rgba(208, 251, 203, 0.55); }

    .endpoint { margin-bottom: 1.5rem; padding-bottom: 1.5rem; border-bottom: 1px solid rgba(7, 36, 27, 0.1); }
    .endpoint:last-child { border-bottom: none; padding-bottom: 0; margin-bottom: 0; }
    .method {
      display: inline-block; padding: 2px 8px; border-radius: 6px;
      font-family: 'Bricolage Grotesque', sans-serif;
      font-size: 0.72rem; font-weight: 800; margin-right: 0.5rem; color: var(--dark);
      letter-spacing: 0.02em;
    }
    .get { background: var(--green); }
    .post { background: var(--mint); }
    .head { background: var(--violet); }

    table { width: 100%; border-collapse: collapse; margin: 0.5rem 0; }
    th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid rgba(7, 36, 27, 0.12); font-size: 0.9rem; }
    th { color: rgba(7, 36, 27, 0.6); font-weight: 700; font-family: 'Bricolage Grotesque', sans-serif; }
    td code { font-size: 0.82rem; }

    .note {
      background: var(--mint); color: var(--dark);
      border-left: 4px solid var(--green); padding: 0.7rem 0.9rem;
      border-radius: 0 12px 12px 0; margin: 0.75rem 0; font-size: 0.92rem;
    }
    .note strong { color: var(--dark); }

    /* Divider */
    .section-divider {
      text-align: center; padding: 2.25rem 0 1rem;
      color: var(--mint); font-size: 0.82rem;
      font-family: 'Bricolage Grotesque', sans-serif; font-weight: 700;
      letter-spacing: 0.08em; text-transform: uppercase;
    }
    .section-divider span {
      background: var(--dark); padding: 0 1rem; position: relative;
    }
    .section-divider::before {
      content: ''; display: block; height: 1px;
      background: rgba(208, 251, 203, 0.2);
      position: relative; top: 0.7rem;
    }

    /* Verify flow */
    .verify-here {
      box-shadow: 6px 6px 0 var(--yellow);
      background: var(--off);
    }
    .verify-lead { font-size: 1rem; color: var(--dark); margin-bottom: 1rem; }
    .verify-step-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 14px;
    }
    .verify-card {
      background: var(--mint); color: var(--dark);
      border: 2px solid var(--dark); border-radius: 16px;
      padding: 16px;
    }
    .step-pill {
      display: inline-block;
      background: var(--dark); color: var(--mint);
      border-radius: 999px; padding: 4px 10px;
      font-family: 'Bricolage Grotesque', sans-serif;
      font-size: 0.7rem; font-weight: 800;
      letter-spacing: 0.04em; text-transform: uppercase;
      margin-bottom: 0.7rem;
    }
    .field-label {
      display: block; font-size: 0.82rem; color: var(--dark);
      margin-bottom: 0.3rem; font-weight: 700;
    }
    .field-input, .field-select {
      width: 100%; padding: 10px 12px;
      border: 2px solid var(--dark); border-radius: 12px;
      font-size: 0.95rem; font-family: 'Inter', sans-serif;
      margin-bottom: 0.6rem;
      background: var(--off); color: var(--dark);
      outline: none; transition: box-shadow 0.15s ease;
    }
    .field-input:focus, .field-select:focus {
      box-shadow: 3px 3px 0 var(--green);
    }
    .field-help {
      color: rgba(7, 36, 27, 0.65); font-size: 0.82rem;
      margin-top: -0.1rem; margin-bottom: 0.55rem;
    }
    .status-row {
      display: none; padding: 10px 14px;
      border-radius: 12px; margin-top: 0.75rem;
      font-size: 0.9rem; line-height: 1.4;
      border: 1px solid transparent;
    }
    .verify-btn {
      padding: 10px 16px; border-radius: 12px;
      border: 2px solid var(--dark);
      background: var(--dark); color: var(--mint);
      font-family: 'Bricolage Grotesque', sans-serif;
      font-size: 0.95rem; font-weight: 700;
      cursor: pointer;
      transition: transform 0.15s ease, box-shadow 0.15s ease, opacity 0.2s;
    }
    .verify-btn:hover:not(:disabled) { transform: translate(-2px, -2px); box-shadow: 4px 4px 0 var(--green); }
    .verify-btn:disabled { cursor: not-allowed; opacity: 0.55; }
    .verify-btn-primary { background: var(--green); color: var(--dark); }
    .verify-btn-primary:hover:not(:disabled) { box-shadow: 4px 4px 0 var(--dark); }
    .verify-btn-success { background: var(--yellow); color: var(--dark); }
    .verify-btn-success:hover:not(:disabled) { box-shadow: 4px 4px 0 var(--dark); }
    .verify-step-gap { margin-top: 1.25rem; }
    /* Room above a card when a platform pill jumps to it. */
    .verify-card { scroll-margin-top: 16px; }
    /* Card titles under a step heading: h4 for structure, styled like the step titles. */
    .verify-card h4 { font-size: 1.05rem; color: var(--dark); margin: 0 0 0.5rem; }
    .advanced-proof {
      margin-top: 1rem;
      border: 2px dashed rgba(7, 36, 27, 0.25);
      border-radius: 16px; padding: 14px 16px;
      background: rgba(7, 36, 27, 0.04);
    }
    .advanced-proof summary {
      cursor: pointer; font-weight: 800; color: var(--dark);
      font-family: 'Bricolage Grotesque', sans-serif;
      outline: none;
    }
    .advanced-proof-inner { margin-top: 0.85rem; }

    /* Lookup section */
    .lookup-input {
      flex: 1; min-width: 200px;
      padding: 10px 14px;
      border: 2px solid var(--dark); border-radius: 12px;
      font-size: 0.95rem; font-family: 'Inter', sans-serif;
      background: var(--off); color: var(--dark);
      outline: none; transition: box-shadow 0.15s ease;
    }
    .lookup-input:focus { box-shadow: 3px 3px 0 var(--green); }
    .lookup-btn {
      padding: 10px 22px;
      background: var(--dark); color: var(--mint);
      border: 2px solid var(--dark); border-radius: 12px;
      font-family: 'Bricolage Grotesque', sans-serif;
      font-size: 0.95rem; font-weight: 800;
      cursor: pointer;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
    .lookup-btn:hover { transform: translate(-2px, -2px); box-shadow: 4px 4px 0 var(--green); }
    .lookup-status {
      display: none; padding: 10px 14px;
      border-radius: 12px; margin-bottom: 0.85rem;
      font-size: 0.9rem; border: 1px solid transparent;
    }

    /* Footer */
    footer {
      text-align: center; padding: 56px 0 40px;
      color: var(--mint); font-size: 0.92rem;
      border-top: 1px solid rgba(208, 251, 203, 0.14);
      margin-top: 32px;
    }
    footer a { color: var(--off); border-bottom: 1.5px solid rgba(249, 247, 246, 0.35); padding-bottom: 1px; text-decoration: none; }
    footer a:hover { color: var(--green); border-bottom-color: var(--green); }

    @media (max-width: 640px) {
      .container { padding: 0 18px; }
      .hero { padding: 18px 0 16px; }
      .nav-actions { width: 100%; justify-content: flex-start; }
      section { padding: 18px; }
    }
`
