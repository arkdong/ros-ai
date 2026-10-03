# UvA dean demo — meeting notes and pitch outline

**Draft for Adam to review and correct · prepared 2 October 2026**

Based on Adam’s meeting recollection, rather than a verified transcript. Suggested wording below is newly drafted, not a quotation from the meeting. This document prepares the discussion; it does not establish demo readiness or institutional commitments.

| Item | Recollection / confirmation needed |
| --- | --- |
| Preparation meeting | Adam met “today” with **Mark Siever**; spelling and exact meeting date to confirm. |
| Intended audience | Dean of **UvA Business School**, with a department transcribed as **“McNamara Business Department”**; exact department and participants to confirm. |
| Dean demo | Planned for “next week”; exact date and format to confirm. |
| Follow-up planning | Discuss the examples and demo scope on “Monday”; exact date to confirm. |

## What Adam recalled

### Start with a personal, practical problem

Research ideas, history and useful information become scattered across conversations, project folders and tools. Adam’s own workaround is a general memory vault above individual project folders. It stores history, memory and context, with a main coordinating thread overseeing the projects.

That experience provides the opening: useful general AI tools still leave the researcher responsible for assembling continuity across tools and threads. Claude Code—the likely meaning of the transcription “cloud code”—and Codex can be part of that work. The issue to explain is accessibility and fit for a researcher’s way of working. The professor is mainly familiar with Claude Code; confirm which participant this refers to and make the comparison concrete for that audience.

Research needs room for intuition, creativity and inspiration. Preserved context can support those qualities by helping someone return to an idea, understand earlier choices and pursue a new direction. Creativity cannot be reduced entirely to stored context.

Here, context includes history, prompts, preferences, persona, skills and workflows. Researchers have different tools, models and preferences, and disciplines approach research differently. The workspace should accommodate those differences rather than prescribe one universal method.

### Continuity matters when research team or lab members change

In a research team or lab, students ranging from research assistants to PhD students come and go. Incoming members need time to adapt to existing methods, tools and accumulated context. When members leave, successors can struggle to inherit their knowledge, decisions and workflows. Differences in engineering skills can make that handover harder and impede the adoption and effective use of AI tools.

The opportunity is to preserve continuity and make knowledge transfer easier: what was tried, which evidence was used, why choices were made, what remains open, and how to continue. This is a motivation to explore with users, not a claim that handover has already been solved.

### Use existing work to explain the lessons

Before introducing ros.ai, consider showing existing **ISO internal agents for nontechnical users** and/or **ABN AMRO work**. These are candidate examples from Adam’s recollection; the ISO expansion, exact materials and suitability for this audience need confirmation. They are not established ros.ai integrations.

The recalled lesson from building and evaluating these solutions is that explainability, traceability, transparency and reproducibility are essential. Clarity, local operation and privacy also matter. Explain these through a concrete example the audience can inspect, rather than as a list of promises.

For this pitch, reproducibility means aspiring to preserve enough inputs, methods and evidence to inspect and repeat relevant work where possible. It does not mean deterministic replay of a model. Local operation also needs a precise explanation: the workspace can run locally while selected model or search calls still go to external services.

### Begin with the student research community

The proposed bottom-up starting point is workshops with the student assistant and student research community, alongside interviews with early researchers and student assistants. Use these to discover actual needs, tools and workflows, then shape the sandbox from those findings. Extending to researchers and professors comes later as the needs become clearer.

The intended learners include students, student researchers, early researchers and student/research assistants. The purpose is to help them learn thoughtful AI-assisted research while exploring and quickly evaluating ideas, with meaningful learning and research outcomes as the measure of value.

## Proposed pitch sequence

| Step | Message and possible material |
| --- | --- |
| 1. Personal story | Show how Adam’s ideas and history scatter, then explain the vault and coordinating-thread workaround. |
| 2. Research continuity | Connect that experience to intuition, inspiration, individual working methods and assistant turnover. |
| 3. Existing examples | Show one suitable ISO and/or ABN AMRO example. Explain the lessons about clarity, traceability and research quality. |
| 4. Introduce ros.ai | Present a visual exploratory research sandbox with inspectable history and deliberate reuse of evidence. |
| 5. Learning and discovery | Explain workshops and interviews as the way to learn what students and assistants actually need. |
| 6. Value for the dean | Discuss how complementary experimentation could support his vision and AI research program; confirm the institutional framing below. |
| 7. Candidate demonstrations | Finish with a finance/FinTech case and an accessible nontechnical case, subject to Monday’s selection and scope. |

### Possible opening wording

> In my own research, an idea often starts in one conversation, develops in another, and leaves useful information across several tools. I built a memory vault above my project folders, with a coordinating thread to keep the history and context together. That helps me continue, but it also shows how much work a researcher has to do to maintain that continuity.
>
> Claude Code and Codex are useful parts of this process. I want to explore how we can make this way of working more accessible to researchers and student assistants, while preserving the context that helps them follow their own questions and inspiration.

### Introducing ros.ai accurately

Suggested proposition: **ros.ai is a visual, transparent exploratory research workspace with history, where people can keep context and evidence together while following their own questions.** Tool connections and routine assistance should support the work without demanding constant attention; their use and outputs should remain visible and inspectable.

Keep these points clear in the explanation and any selected demonstration:

- Research blocks/nodes work independently on one expandable canvas. Knowledge represents what is studied; Action represents what is done. Groups organize the work.
- Connections express relationships. They do not schedule work, block another node or automatically import its inputs. Reusing a result is deliberate and preserves its selected version and origin.
- Researchers retain control of the canvas structure. Project and node conversations are separate; manual content edits are undoable, and agent additions follow the selected approval mode and shared limits. Ask requires specific approval.
- History and provenance concern observable requests, selected inputs, methods and saved artifacts. They do not reveal hidden reasoning or guarantee scientific correctness.
- The current application is local and CLI-launched with a browser frontend. External model/search calls require their own permissions and resources; local operation alone is not a blanket privacy guarantee.

The current project direction also prioritizes a simpler workspace usable without AI. Distinct Code and Notebook blocks are planned objectives, not completed functionality. Any presentation should show only behavior actually available in the chosen demo and label proposed capabilities as proposed.

## Proposed value for the dean

Adam’s proposed framing is that ros.ai could help accelerate the dean’s vision and AI research program by providing room for quick prototypes, experimentation and learning **while an official UvA AI environment is being established**. That institutional timing and its relevance must be confirmed; they are not verified facts or an official commitment.

The emphasis is complementary experimentation: help students and researchers explore possibilities, turn inspiration into inspectable work, and learn what produces meaningful outcomes for students and UvA. Workshops and interviews could provide practical evidence about useful workflows. No partnership, budget, deployment commitment or formal ask was settled in this recollection.

Optional discussion questions:

- Which student or research-assistant workflows would be most useful to explore first?
- What would make a small experiment valuable to the dean’s research and learning priorities?
- How could this exploratory work complement the institution’s plans and requirements?

## Candidate final demos — selection pending

| Candidate | Possible focus | What Monday needs to settle |
| --- | --- | --- |
| Finance / FinTech | A case perhaps adapted from ABN AMRO work, illustrating a question, evidence, an analysis and its history. | Choose the question, appropriate materials, adaptation scope and actual behavior to show. |
| Accessible nontechnical case | A case perhaps using statistics within ISO, showing how someone without substantial engineering experience can inspect and explore an idea. | Confirm what ISO refers to, choose an understandable question and decide how much technical detail is useful. |

Both are candidates. No new demo has been built or its readiness established by these notes. The same pitch sequence can work with different examples; it should not imply a required research pipeline.

## Compact Monday decisions

1. **Audience and message:** confirm participants, their familiarity with AI tools, the main point to leave with the dean, presentation length and speaking roles.
2. **Examples:** choose the pre-ros.ai ISO/ABN AMRO illustration and the two final demo cases; identify the exact materials suitable to show.
3. **Scope:** agree the minimum useful story for each case, what already works, what would need preparation, and which proposed features should remain discussion only.
4. **Institutional framing:** confirm the dean’s priorities and the timing of the official AI environment before using that framing.
5. **Facts and wording:** resolve the confirmations below and settle the exact meeting, Monday and demo dates.

## Confirm before using externally

| Open item | Review needed |
| --- | --- |
| Mark Siever | Correct name/spelling and role. |
| UvA participants and department | Exact dean/participants, official school/department names, and what “McNamara Business Department” meant. |
| Professor’s tool familiarity | Which participant is mainly familiar with Claude Code; confirm “cloud code” meant Claude Code. |
| Dates | Exact preparation-meeting date, Monday planning date and next-week demo date. |
| ISO | Full name/expansion, relevant internal-agent/statistics example and materials to show. |
| ABN AMRO example | Exact work being referenced and a suitable scope for this audience. |
| Institutional timing | Whether the official UvA AI environment is being established and whether the complementary framing fits the dean’s priorities. |
| Optional trend reference | Adam recalled a recent ChatGPT announcement transcribed as “dot from Meta, it’s Muse,” concerning consolidated context across threads. Identify the intended product/announcement and verify it before possible inclusion; do not guess or use it as evidence yet. |

Project terminology and boundaries were checked against [AGENTS.md](../AGENTS.md), [README.md](../README.md), the [product brief](product-brief.md), [architecture](architecture.md), [foundation milestone](history/foundation-milestone.md) and [context and decisions](context-and-decisions.md). These sources clarify product scope; they do not verify the meeting recollection or institutional details.
