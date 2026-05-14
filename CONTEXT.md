# fsdecryptGUI

fsdecryptGUI extracts arcade game images and update images through a small set of user-facing extraction modes.

## Language

**Base**:
An extraction mode for a standalone game image.
_Avoid_: Container, Game

**Option**:
An extraction mode for an update image that extends a game image.
_Avoid_: Update mode, OPT mode

**Merge**:
An extraction mode for resolving multiple related image layers into one extracted view.
_Avoid_: VHD mode, Chain mode

**APP**:
A game image selected for **Base** or **Merge** extraction.
_Avoid_: App file, game container

**OPTION**:
An update image selected for **Option** extraction.
_Avoid_: OPT, option file, update container

**VHD Layer**:
A disk image layer that can participate in a resolved chain.
_Avoid_: VHD, raw disk, virtual disk

**Layer Chain**:
A set of related image layers that must be resolved together.
_Avoid_: Chain

**APP Chain**:
A **Layer Chain** formed from APPs.
_Avoid_: Game chain

**VHD Chain**:
A **Layer Chain** formed from **VHD Layers**.
_Avoid_: Raw VHD chain

**Parent Layer**:
A layer required by another layer in the same **Layer Chain**.
_Avoid_: Base layer

**Child Layer**:
A layer that depends on another layer in the same **Layer Chain**.
_Avoid_: Dependent layer

**Blocking Warning**:
A selected-input condition that prevents extraction until the selection changes.
_Avoid_: Warning

**Notice**:
A selected-input message that informs the user without preventing extraction.
_Avoid_: Informational warning

**Selection Queue**:
The current mode's chosen inputs, kept as an editable list.
_Avoid_: Selection, picker result

**Selection Group**:
An analyzed subset of a **Selection Queue** that can be evaluated as one extraction candidate or one chain.
_Avoid_: Group, card

**Extraction Job**:
One unit of extraction work started from the current **Selection Queue**.
_Avoid_: Export job, file, run item

**Output Folder**:
The local folder where extraction results are written.
_Avoid_: Output root, destination

**Key Source**:
The key material used to read selected APPs or OPTIONs.
_Avoid_: Key, key table

**Built-in Key Source**:
The bundled **Key Source** used when no custom file is selected.
_Avoid_: Built-in key table

**Custom Key File**:
A user-selected file used as the **Key Source**.
_Avoid_: External key file

**Extraction Batch**:
The set of **Extraction Jobs** started by one run action.
_Avoid_: Export batch, run, batch

**Extraction Record**:
A saved summary of one completed, failed, or cancelled **Extraction Job**.
_Avoid_: Export record, history item

## Relationships

- A **Base** extraction extracts one standalone game image.
- An **Option** extraction extracts one update image.
- A **Merge** extraction resolves one or more image layers into a single extracted view.
- An **APP** may contain a **VHD Layer**.
- An **OPTION** may contain a **VHD Layer**.
- An **APP Chain** is a **Layer Chain**.
- A **VHD Chain** is a **Layer Chain**.
- A **Child Layer** depends on exactly one **Parent Layer** when the dependency is known.
- A **Parent Layer** may have one or more **Child Layers**.
- A **Blocking Warning** belongs to the current selection, not to the extraction result.
- A **Notice** belongs to the current selection and does not prevent extraction.
- A **Selection Queue** contains APPs, OPTIONs, or **VHD Layers** depending on the current extraction mode.
- A **Selection Queue** contains one or more **Selection Groups** after analysis.
- A **Selection Group** may have a **Blocking Warning** or **Notice**.
- A **Base** **Extraction Job** starts from one APP.
- An **Option** **Extraction Job** starts from one OPTION.
- A **Merge** **Extraction Job** starts from one **Selection Group**.
- An **Extraction Job** writes its results to the **Output Folder**.
- A **Key Source** is either the **Built-in Key Source** or a **Custom Key File**.
- An **Extraction Batch** contains one or more **Extraction Jobs**.
- An **Extraction Record** belongs to exactly one **Extraction Job**.
- A standalone base **VHD Layer** may be extracted without a **Child Layer**.

## Example dialogue

> **Dev:** "The **Selection Queue** has a **Child Layer** without its **Parent Layer**. Should we still create an **Extraction Job**?"
> **Domain expert:** "No. That is a **Blocking Warning**. The user needs to add the **Parent Layer** or remove the **Child Layer** first."

## Flagged ambiguities

- "container" was used as an internal name for **Base**; resolved: **Base** is the user-facing mode name.
- "vhd" was used as an internal name for **Merge**; resolved: **Merge** is the user-facing mode name.
- "Option" can mean the **Option** extraction mode, while **OPTION** means the selected update image.
- "chain" was used alone for linked inputs; resolved: **Layer Chain** is the general term, with **APP Chain** and **VHD Chain** used for specific forms.
- "base layer" can be confused with **Base** mode; resolved: use **Parent Layer** for dependency direction.
- "warning" means a hard stop in this UI; resolved: use **Blocking Warning** when the domain meaning needs to be explicit.
- "informational warning" is contradictory in this UI; resolved: use **Notice** for non-blocking selection messages.
- "selection" was used for both picker results and the editable input list; resolved: use **Selection Queue** for the editable list.
- "group" and "card" were used loosely for analyzed queue sections; resolved: use **Selection Group**.
- "file" and "group" both described run units in different modes; resolved: use **Extraction Job** for the general run unit.
- "output root" and "output segments" describe path mechanics; resolved: use **Output Folder** for the user-facing destination.
- "external key file" and "custom key" both described user-provided keys; resolved: use **Custom Key File**.
- "run" and "batch" both described the work started by the main action; resolved: use **Extraction Batch** for that set of jobs.
- "history item" described saved extraction results; resolved: use **Extraction Record**.
- "export" was used for user-facing extraction concepts; resolved: use extraction language in the domain glossary.
- "Games" and "Updates" are acceptable friendly UI labels for APPs and OPTIONs, but **APP** and **OPTION** remain the canonical domain terms.
- "History" is an acceptable friendly UI label for the list of **Extraction Records**.
- Raw **VHD Layers** selected alongside APPs produce a **Notice**, not a **Blocking Warning**, because they are extracted as a separate **VHD Chain**.
- A raw **VHD Chain** with a missing **Parent Layer**, multiple base layers, or unlinked intermediate layers produces a **Blocking Warning**.
