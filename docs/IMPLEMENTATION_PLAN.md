# Implementation plan

1. Verify the BrightSign APIs and build one bootable SD package for three XD236s with distinct local frame-counter clips. Validate the package and stream timelines on a workstation.
2. Run the [hardware checklist](HARDWARE_TEST.md) on a wired bench. Record actual firmware, sync start, late join, leader loss and loop evidence. Establish the native playback path before starting the CMS.
3. Once that gate passes, add a playback state machine, revision-aware prepare/ready barrier and coordinated controls. Prove recovery before adding transfer load.
4. Add the leader-hosted CMS, commissioning, runtime media checks, peer distribution, durable commits and rollback. Test using mocked peers and then test upload and playback together on hardware.
5. Complete authenticated REST control, security and fault testing, packaging, operation guides and all mandatory acceptance tests in the product specification.
