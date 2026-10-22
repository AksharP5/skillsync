# Changelog

## [0.14.1](https://github.com/AksharP5/skillsync/compare/v0.14.0...v0.14.1) (2026-10-22)


### Bug Fixes

* apply pulled changes before retrying a sync push ([#107](https://github.com/AksharP5/skillsync/issues/107)) ([869c004](https://github.com/AksharP5/skillsync/commit/869c0049e1e49585292605237bc7634e5de7e87c))
* **cli:** report pending plugin profile assignments accurately ([#105](https://github.com/AksharP5/skillsync/issues/105)) ([e3e3859](https://github.com/AksharP5/skillsync/commit/e3e3859bef8a1fde32053b9cec365fe4756988aa))
* **cli:** suggest unlinked instruction paths in settings ([#121](https://github.com/AksharP5/skillsync/issues/121)) ([bcbe710](https://github.com/AksharP5/skillsync/commit/bcbe71029a3e31df69c6ee638b9aa27a7f47b2bb))
* detect owned skill projections by their vault name ([#116](https://github.com/AksharP5/skillsync/issues/116)) ([21c4a85](https://github.com/AksharP5/skillsync/commit/21c4a854dac087ee185c6f8d5385920b7067103e))
* discover OpenCode skills in the XDG config directory ([#109](https://github.com/AksharP5/skillsync/issues/109)) ([54a83f7](https://github.com/AksharP5/skillsync/commit/54a83f7ea1db462956f04e40a939fc0e601fa434))
* fail safely on scan errors and invalid vault metadata ([#94](https://github.com/AksharP5/skillsync/issues/94)) ([62080a7](https://github.com/AksharP5/skillsync/commit/62080a785e3a7ccb4d5c8c15faf8747c4c9b3a30))
* honor local sources and renamed skill assignments ([#91](https://github.com/AksharP5/skillsync/issues/91)) ([da749ad](https://github.com/AksharP5/skillsync/commit/da749ad180313c7f43d84d2582b1c81947264f00))
* install Linux services in the XDG config directory ([#101](https://github.com/AksharP5/skillsync/issues/101)) ([4762cbe](https://github.com/AksharP5/skillsync/commit/4762cbe1e42e66b08c043f7d54cc0a4223a227b4))
* keep configured paths stable across working directories ([#99](https://github.com/AksharP5/skillsync/issues/99)) ([262b140](https://github.com/AksharP5/skillsync/commit/262b140f1e66f1db42a00bc28b73a6cc1d58ed9c))
* keep Cursor rules stable through directory aliases ([#123](https://github.com/AksharP5/skillsync/issues/123)) ([e45c411](https://github.com/AksharP5/skillsync/commit/e45c4119e23834711a761fbd857def2256649c4e))
* keep instruction destinations stable across directories ([#103](https://github.com/AksharP5/skillsync/issues/103)) ([8df5501](https://github.com/AksharP5/skillsync/commit/8df5501eacd8e4d6830a8b0513163984335f6573))
* keep read-only skill copies recoverable during sync ([#128](https://github.com/AksharP5/skillsync/issues/128)) ([e101880](https://github.com/AksharP5/skillsync/commit/e101880be697ff51f96f55877f20093dc8705d9c))
* keep remote skill names stable and honor name overrides ([#97](https://github.com/AksharP5/skillsync/issues/97)) ([cf90147](https://github.com/AksharP5/skillsync/commit/cf9014731ae10cddbbc715fdd8f4ad107405a7b5))
* keep sync working after remote skill deletion ([#125](https://github.com/AksharP5/skillsync/issues/125)) ([96c7a72](https://github.com/AksharP5/skillsync/commit/96c7a72524098ede0982473a6c757e84adfa1845))
* keep target folders consistent with managed projections ([#87](https://github.com/AksharP5/skillsync/issues/87)) ([c62a88a](https://github.com/AksharP5/skillsync/commit/c62a88a64ae8a9c4acc1f0dd00976ecaeb2ec19b))
* preserve every local skill path in adoption baselines ([#115](https://github.com/AksharP5/skillsync/issues/115)) ([68bd001](https://github.com/AksharP5/skillsync/commit/68bd001ff34f4d6be8c03e0e67d6c36fa4774d4b))
* preserve instructions after interrupted profile switches ([#85](https://github.com/AksharP5/skillsync/issues/85)) ([633a458](https://github.com/AksharP5/skillsync/commit/633a45832db984888ba3281c32aed6fcf2e1bd8a))
* preserve instructions when detaching a managed link fails ([#135](https://github.com/AksharP5/skillsync/issues/135)) ([db971f2](https://github.com/AksharP5/skillsync/commit/db971f2544247b8a4ce8b111df64c1af40560685))
* preserve legacy assignments when deleting a skill ([#117](https://github.com/AksharP5/skillsync/issues/117)) ([5555169](https://github.com/AksharP5/skillsync/commit/5555169b01f543878c3e7a4ca2b96c489dbbde6d))
* preserve percent signs in Linux service paths ([#133](https://github.com/AksharP5/skillsync/issues/133)) ([f17cc4e](https://github.com/AksharP5/skillsync/commit/f17cc4eb98c5a1723b6e16e6a1a0d1dc89f80aff))
* preserve plugin reports when inventory is malformed ([#90](https://github.com/AksharP5/skillsync/issues/90)) ([792c5d6](https://github.com/AksharP5/skillsync/commit/792c5d62d1b79d938cb82bda9f84b7cac92a81f5))
* preserve vault skills during failed overwrites ([#114](https://github.com/AksharP5/skillsync/issues/114)) ([49d0949](https://github.com/AksharP5/skillsync/commit/49d0949149f6a835302fa365aafb80db83683d27))
* reject invalid device state before removing skills ([#96](https://github.com/AksharP5/skillsync/issues/96)) ([35b8ee7](https://github.com/AksharP5/skillsync/commit/35b8ee7bbc66f3a92f7175ea0e4d4849df26e655))
* reject malformed config before selecting a vault ([#89](https://github.com/AksharP5/skillsync/issues/89)) ([e309a05](https://github.com/AksharP5/skillsync/commit/e309a0597bc47316389d33f2c6da851bc8c217fb))
* reject target names reserved for global installs ([#124](https://github.com/AksharP5/skillsync/issues/124)) ([e3d6096](https://github.com/AksharP5/skillsync/commit/e3d60967eae806f6f455fab3102d5cf74a9a68e3))
* remove obsolete generated skill packs ([#88](https://github.com/AksharP5/skillsync/issues/88)) ([760abad](https://github.com/AksharP5/skillsync/commit/760abadc188ec416885cd3834d9d83863031eb46))
* restore target state when persistence fails ([#130](https://github.com/AksharP5/skillsync/issues/130)) ([381ea9c](https://github.com/AksharP5/skillsync/commit/381ea9c7630cbde75990577217289d33b570d47a))
* retry failed backups after remote skill deletions ([#137](https://github.com/AksharP5/skillsync/issues/137)) ([4f8c02c](https://github.com/AksharP5/skillsync/commit/4f8c02c55a8a85d4ce0336d6f284f7803e23455e))
* stop skipping standalone folders during uninstall ([#131](https://github.com/AksharP5/skillsync/issues/131)) ([28a557d](https://github.com/AksharP5/skillsync/commit/28a557d5da1f7031c5553b314c60b51a730a7e93))
* stop sync before committing unresolved Git conflicts ([#84](https://github.com/AksharP5/skillsync/issues/84)) ([8b81705](https://github.com/AksharP5/skillsync/commit/8b8170532160e72912fffd0a90726f7e1c79dd60))
* sync executable permissions in managed skill copies ([#95](https://github.com/AksharP5/skillsync/issues/95)) ([41d150f](https://github.com/AksharP5/skillsync/commit/41d150ffe7a2681c451a5544426a7806f63387df))


### Performance Improvements

* cut repeated reads when syncing multiple copy targets ([#139](https://github.com/AksharP5/skillsync/issues/139)) ([30fbbef](https://github.com/AksharP5/skillsync/commit/30fbbefbbd9372a4669fadf71edf2db82de664a3))
* speed up idle sync by skipping redundant scans ([#92](https://github.com/AksharP5/skillsync/issues/92)) ([bdf1e94](https://github.com/AksharP5/skillsync/commit/bdf1e94476620bf6cdb6dd25035ee0fb1a99c458))
* stop rewriting unchanged skill registries ([#93](https://github.com/AksharP5/skillsync/issues/93)) ([5b64fbc](https://github.com/AksharP5/skillsync/commit/5b64fbc3b4c5ff63da0cc15e9d9847f6f92120c4))

## [0.14.0](https://github.com/AksharP5/skillsync/compare/v0.13.0...v0.14.0) (2026-10-04)


### Features

* share instruction profiles with Cursor CLI ([519a9cc](https://github.com/AksharP5/skillsync/commit/519a9ccec002f9e3ffaba6eee304380e324804ea))


### Bug Fixes

* preserve instructions when recovering broken links ([b1e0586](https://github.com/AksharP5/skillsync/commit/b1e058633669c9daf34584189cc00a823eed28a5))

## [0.13.0](https://github.com/AksharP5/skillsync/compare/v0.12.2...v0.13.0) (2026-10-04)


### Features

* auto-detect Grok Bot skills target ([#70](https://github.com/AksharP5/skillsync/issues/70)) ([e3d53c1](https://github.com/AksharP5/skillsync/commit/e3d53c12f4e4188688e4b48d1add04de061adaca))
* sync global AGENTS.md to Grok Bot ([#72](https://github.com/AksharP5/skillsync/issues/72)) ([dd24ae3](https://github.com/AksharP5/skillsync/commit/dd24ae30a972ba3cfc63eafb9d2abea8e88985f1))


### Bug Fixes

* keep instruction aliases linked when unlinking a path ([#78](https://github.com/AksharP5/skillsync/issues/78)) ([a823348](https://github.com/AksharP5/skillsync/commit/a82334845b6fd711778c7e23dc2f4c52b994eb3e))
* preserve local files when changing sync targets ([#74](https://github.com/AksharP5/skillsync/issues/74)) ([3eb7296](https://github.com/AksharP5/skillsync/commit/3eb729646f39d2ba961be68da3c70120323c12e1))
* stop config fallback and duplicate instruction backups ([#76](https://github.com/AksharP5/skillsync/issues/76)) ([7b5a19f](https://github.com/AksharP5/skillsync/commit/7b5a19ff2c921fdc10321d9bfe763e61b8e07c71))

## [0.12.2](https://github.com/AksharP5/skillsync/compare/v0.12.1...v0.12.2) (2026-09-10)


### Bug Fixes

* stop ignored local files from churning vault history ([#68](https://github.com/AksharP5/skillsync/issues/68)) ([e6619d3](https://github.com/AksharP5/skillsync/commit/e6619d39dc43845c4196d4f14d4b91cbeeb71c7a))

## [0.12.1](https://github.com/AksharP5/skillsync/compare/v0.12.0...v0.12.1) (2026-08-31)


### Bug Fixes

* stop Codex updates from churning vault history ([#64](https://github.com/AksharP5/skillsync/issues/64)) ([bd45168](https://github.com/AksharP5/skillsync/commit/bd45168ab291f39d3f0b57528c11ffa4402b312c))

## [0.12.0](https://github.com/AksharP5/skillsync/compare/v0.11.0...v0.12.0) (2026-08-24)


### Features

* add recoverable sync and read-only checks ([caa5852](https://github.com/AksharP5/skillsync/commit/caa58522e74ad948e3ed7e0bf895c7415570e06f))


### Bug Fixes

* close remaining validation gaps ([#63](https://github.com/AksharP5/skillsync/issues/63)) ([d387781](https://github.com/AksharP5/skillsync/commit/d387781969ca383064e167d51be782fb1044aaa1))
* close sync safety edge cases ([b6358c9](https://github.com/AksharP5/skillsync/commit/b6358c93578826c8af0402371347bb356298b531))

## [0.11.0](https://github.com/AksharP5/skillsync/compare/v0.10.6...v0.11.0) (2026-08-10)


### Features

* propagate new plugins across shared profiles ([#59](https://github.com/AksharP5/skillsync/issues/59)) ([ffd8801](https://github.com/AksharP5/skillsync/commit/ffd8801cf81511b993d2725f763431bae5194e2e))
* sync Codex plugin profiles ([#57](https://github.com/AksharP5/skillsync/issues/57)) ([a3725d6](https://github.com/AksharP5/skillsync/commit/a3725d6568dd995f5782b77af5f8eace0c10da55))

## [0.10.6](https://github.com/AksharP5/skillsync/compare/v0.10.5...v0.10.6) (2026-08-06)


### Bug Fixes

* **cli:** show only skill selection changes ([#54](https://github.com/AksharP5/skillsync/issues/54)) ([9d3f0d7](https://github.com/AksharP5/skillsync/commit/9d3f0d7d2015c3686c1800797159b79c5a311769))
* support symlinked skill directories ([#56](https://github.com/AksharP5/skillsync/issues/56)) ([9277321](https://github.com/AksharP5/skillsync/commit/92773214fff95406ac8f91d53972ab4d7ed7f0c6))

## [0.10.5](https://github.com/AksharP5/skillsync/compare/v0.10.4...v0.10.5) (2026-07-31)


### Bug Fixes

* **cli:** document complete agent setup ([#50](https://github.com/AksharP5/skillsync/issues/50)) ([55df488](https://github.com/AksharP5/skillsync/commit/55df4886b29702ac98ae20849b2635b61aef7e5f))

## [0.10.4](https://github.com/AksharP5/skillsync/compare/v0.10.3...v0.10.4) (2026-07-31)


### Bug Fixes

* retry busy launchd bootstrap ([#48](https://github.com/AksharP5/skillsync/issues/48)) ([3cb07a9](https://github.com/AksharP5/skillsync/commit/3cb07a9a153d39fa729e1988c627994ad303ac32))

## [0.10.3](https://github.com/AksharP5/skillsync/compare/v0.10.2...v0.10.3) (2026-07-31)


### Bug Fixes

* recognize canonical instruction links ([#46](https://github.com/AksharP5/skillsync/issues/46)) ([32132c7](https://github.com/AksharP5/skillsync/commit/32132c75aa9ae2f24eb24beed895dd91e9beab24))

## [0.10.2](https://github.com/AksharP5/skillsync/compare/v0.10.1...v0.10.2) (2026-07-31)


### Bug Fixes

* support symlinked instruction directories ([#44](https://github.com/AksharP5/skillsync/issues/44)) ([8711c3a](https://github.com/AksharP5/skillsync/commit/8711c3a13c02d63a7e51dafa33b199be6cfa0ddc))

## [0.10.1](https://github.com/AksharP5/skillsync/compare/v0.10.0...v0.10.1) (2026-07-30)


### Bug Fixes

* detect Claude from the local executable ([#35](https://github.com/AksharP5/skillsync/pull/35)) ([678b146](https://github.com/AksharP5/skillsync/commit/678b146aa82a265e1fd5b712039965785ae9b03e))
* keep device filesystem paths private ([#37](https://github.com/AksharP5/skillsync/pull/37)) ([627be0d](https://github.com/AksharP5/skillsync/commit/627be0d3e7b923353821ec077d145286e583444b))

## [0.10.0](https://github.com/AksharP5/skillsync/compare/v0.9.0...v0.10.0) (2026-07-30)


### Features

* add per-device instruction profiles ([#33](https://github.com/AksharP5/skillsync/issues/33)) ([1ac7f9e](https://github.com/AksharP5/skillsync/commit/1ac7f9ec0e50e894ba3789a6b5d71cae201f02b8))

## [0.9.0](https://github.com/AksharP5/skillsync/compare/v0.8.0...v0.9.0) (2026-07-30)


### Features

* sync global AGENTS.md ([#30](https://github.com/AksharP5/skillsync/issues/30)) ([6577e7f](https://github.com/AksharP5/skillsync/commit/6577e7fb5de4e7e107a51f5559c633d9ac2d888f))

## [0.8.0](https://github.com/AksharP5/skillsync/compare/v0.7.1...v0.8.0) (2026-07-30)


### Features

* add editable skill matrix ([#28](https://github.com/AksharP5/skillsync/issues/28)) ([5ddee44](https://github.com/AksharP5/skillsync/commit/5ddee441da4f86fd261929de6a32433d2fd055d1))

## [0.7.1](https://github.com/AksharP5/skillsync/compare/v0.7.0...v0.7.1) (2026-07-30)


### Bug Fixes

* make unused skill cleanup presence aware ([#26](https://github.com/AksharP5/skillsync/issues/26)) ([a6e2437](https://github.com/AksharP5/skillsync/commit/a6e2437b4b75923b124bfc5091faeea1706dcd2a))

## [0.7.0](https://github.com/AksharP5/skillsync/compare/v0.6.1...v0.7.0) (2026-07-30)


### Features

* add clean device state and skill matrix ([#24](https://github.com/AksharP5/skillsync/issues/24)) ([4c83cec](https://github.com/AksharP5/skillsync/commit/4c83cec1f9b3fddfb1380caf1da1849ccd23bc75))

## [0.6.1](https://github.com/AksharP5/skillsync/compare/v0.6.0...v0.6.1) (2026-07-30)


### Bug Fixes

* include executable path in macOS service environment ([#22](https://github.com/AksharP5/skillsync/issues/22)) ([a584957](https://github.com/AksharP5/skillsync/commit/a58495702784b6a1f46ec0b41f39af39c274c880))

## [0.6.0](https://github.com/AksharP5/skillsync/compare/v0.5.1...v0.6.0) (2026-07-30)


### Features

* add cross-device skill management ([#16](https://github.com/AksharP5/skillsync/issues/16)) ([51b5525](https://github.com/AksharP5/skillsync/commit/51b55254a0462cd34391ce46d962d5cba8329738))

## [0.5.1](https://github.com/AksharP5/skillsync/compare/v0.5.0...v0.5.1) (2026-07-29)


### Bug Fixes

* stop daemon heartbeat commits ([#14](https://github.com/AksharP5/skillsync/issues/14)) ([5aae857](https://github.com/AksharP5/skillsync/commit/5aae8575db8f60c821a2050b9f0bdf61322de8f6))

## [0.5.0](https://github.com/AksharP5/skillsync/compare/v0.4.0...v0.5.0) (2026-07-02)


### Features

* generate visual skill groups and packs ([449698e](https://github.com/AksharP5/skillsync/commit/449698e7f9826cdc383f406bab8a68839eac62cb))


### Bug Fixes

* use correct relative links in group pages ([72e78e6](https://github.com/AksharP5/skillsync/commit/72e78e6306c1bb9313a4ee7fcdaa164d53de8de5))

## [0.4.0](https://github.com/AksharP5/skillsync/compare/v0.3.2...v0.4.0) (2026-06-03)


### Features

* show managed projection paths ([5c40162](https://github.com/AksharP5/skillsync/commit/5c40162899d5f2e2528f37170f33abc797973845))
* support device-global skill installs ([5056970](https://github.com/AksharP5/skillsync/commit/505697018bc62708a5181c9bf49f9146ea2b066f))

## [0.3.2](https://github.com/AksharP5/skillsync/compare/v0.3.1...v0.3.2) (2026-06-03)


### Bug Fixes

* recover existing skill projections ([83cd43c](https://github.com/AksharP5/skillsync/commit/83cd43cfc004539c0b774c983f44800a978e350d))

## [0.3.1](https://github.com/AksharP5/skillsync/compare/v0.3.0...v0.3.1) (2026-06-03)


### Bug Fixes

* retry vault push after pulling remote changes ([6d4b749](https://github.com/AksharP5/skillsync/commit/6d4b7490644be71425a5285ebaa48ddf9c266ba2))

## [0.3.0](https://github.com/AksharP5/skillsync/compare/v0.2.1...v0.3.0) (2026-06-03)


### Features

* handle same-name import conflicts ([39bb602](https://github.com/AksharP5/skillsync/commit/39bb6022d23af7068fcf02cd97f9397d4a881dc8))
* import codex and opencode skills ([#7](https://github.com/AksharP5/skillsync/issues/7)) ([c9e39ab](https://github.com/AksharP5/skillsync/commit/c9e39ab00c7105edebcd7b6e090a1ebd85d7d9c9))

## [0.2.1](https://github.com/AksharP5/skillsync/compare/v0.2.0...v0.2.1) (2026-06-03)


### Bug Fixes

* reconcile detected local skills in ui ([9d3bd2e](https://github.com/AksharP5/skillsync/commit/9d3bd2e611527381d7359cb6acc319c1dc0b045f))

## [0.2.0](https://github.com/AksharP5/skillsync/compare/v0.1.3...v0.2.0) (2026-06-03)


### Features

* add installed skills management ([2ffbf8a](https://github.com/AksharP5/skillsync/commit/2ffbf8aea5c6b89c8e95df6ab006308480ccb2c0))

## [0.1.3](https://github.com/AksharP5/skillsync/compare/v0.1.2...v0.1.3) (2026-06-03)


### Bug Fixes

* improve interactive skill browser ([3d316cf](https://github.com/AksharP5/skillsync/commit/3d316cf2384dacb0aca2059f273b0072020f1e8e))

## [0.1.2](https://github.com/AksharP5/skillsync/compare/v0.1.1...v0.1.2) (2026-06-03)


### Bug Fixes

* choose vault mode during interactive setup ([fafb3f5](https://github.com/AksharP5/skillsync/commit/fafb3f56e72be9f6fb9e1c8e1f8c284446b7c3c3))

## [0.1.1](https://github.com/AksharP5/skillsync/compare/v0.1.0...v0.1.1) (2026-06-03)


### Bug Fixes

* clone vault repositories over https ([538df7e](https://github.com/AksharP5/skillsync/commit/538df7ec4320ac81b2a11d40c4cf30f27b1499d0))
