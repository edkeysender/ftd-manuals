---
id: starting-panel
title: Starting Panel
description: >-
  Single rotary knob that starts and shuts down the whole device, with Ready /
  Not Ready indication.
sidebar_position: 7
custom_edit_url: null
---

:::info[Effectivity]
Component **`starting-panel`** · installed software **2.0.1** · documented range `>=2.0.0 <3.0.0` · chunk revision `6355653` (2026-08-27)
:::


The FNPT is started and shut down with a single rotary knob on the starting panel, located above the IOS Lights panel on the IOS wall. Two indicators next to the knob show the device state: **Not Ready** and **Ready**.

## Start-up

1. Confirm the UPS is online and its battery indicator shows it is powered.
2. Turn the knob from **Off** to **On**. This launches the automatic start-up sequence for all simulator computers and processes; no computer needs to be switched on individually.
3. The **Not Ready** indicator stays lit while the device boots. This is normal and takes several minutes.
4. When the sequence completes, **Not Ready** goes out and **Ready** lights up. The simulator can now be set up from the IOS (see the IOS Manual).

## Shutdown

1. Confirm the training session is finished and the IOS scenario is closed.
2. Turn the knob from **On** to **Off**. The indicator changes from **Ready** to **Not Ready** immediately.
3. The shutdown sequence is automatic and needs no operator action. It takes approximately **5 minutes**; the **Not Ready** indicator stays lit until it completes.

:::caution
Do not remove mains power or press an emergency stop while **Not Ready** is lit during shutdown. Wait for the sequence to finish.
:::

If anything unusual happens during start-up or shutdown, contact the manufacturer before the next session to prevent consequential malfunctions.

## Related

- [Emergency Stop Switches](/manuals/b73m-f2m-04-2026/operations/emergency-stop) — pressing an emergency stop may require another start-up.
- Startup panel states are shown in the IOS panel overview photographs (fig. 2.2c in the legacy FCOM; to be replaced by `assets/startup-panel-states.svg`).
