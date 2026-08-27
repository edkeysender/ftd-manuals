---
id: le-devices-annunciator
title: LE Devices Annunciator Panel
description: Indicates leading-edge flap and slat position in relation to the FLAP lever.
sidebar_position: 8
custom_edit_url: null
---

:::info[Effectivity]
Component **`le-devices-annunciator`** · installed software **1.0.0** · documented range `>=1.0.0` · chunk revision `n/a` (—)
:::


The leading edge (LE) devices annunciator panel shows the position of the LE flaps and slats.

## Normal operation

When the FLAP lever is moved from **UP** to **1**, **2** or **5**, the trailing edge (TE) flaps extend to the commanded position and the LE devices:

- flaps extend to the **full extended** position, and
- slats extend to the **extend** (intermediate) position.

When the FLAP lever is moved beyond **5**, the TE flaps extend to the commanded position and the LE devices:

- flaps remain at the full extended position, and
- slats extend to the **full extended** position.

The LE device sequence is reversed on retraction.

## Alternate flap extension

With alternate flap extension the LE flaps and slats are driven to the full extended position by the standby hydraulic system. The **ALTERNATE FLAPS** master switch energises the standby pump; holding the **ALTERNATE FLAPS** position switch momentarily in the down position fully extends the LE devices.

:::note
The LE devices cannot be retracted by the standby hydraulic system.
:::
