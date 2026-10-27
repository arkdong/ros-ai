# ros.ai

Shared language for the exploratory research workspace. Compatible HTTP connections and explicitly scoped guide reviews implement the first stages of the inference design; managed Nemotron packaging and conditional adaptation remain later stages. Current delivery distinguishes implementation from verification.

## Language

**Research model**:
The user's chosen inference connection and model for investigating a research question using authorized context. It can be a personal API, a supported CLI connection, or a locally running model.

**Workspace guide**:
ros.ai's designated model for helping the user organize the workspace and review selected work. Its default context is structure with explicitly selected metadata; reviewing private evidence requires explicit inclusion.

**Inference connection**:
A configured route to a model or supported agent, with an identified processing destination and usage limits. The connection's authentication, permitted context and authority are separate choices.

**Context selection**:
The specific structure, metadata, content and saved evidence versions included in a particular inference request. A relationship, focus change or model choice does not itself add material to this selection.

**Proposal**:
A suggested change or research action awaiting application validation and the project's applicable approval mode. A model response is not execution or a grant of authority.

**Group**:
An organizational frame containing independent research blocks or other Groups on the canvas. Group membership does not schedule research.

**Relationship**:
A named association between research blocks. It expresses meaning without automatically importing evidence or starting work.

**Node input**:
An explicitly selected saved artifact version or excerpt made available to work in a node. Its origin remains inspectable even if the canvas changes.

**Node output**:
A saved artifact produced by a recorded research attempt or explicit content revision. Reusing it elsewhere requires a separate input selection.
