# Changelog

## [0.14.1](https://github.com/AksharP5/skillsync/compare/v0.14.0...v0.14.1) (2026-10-31)


### Bug Fixes

* align Node requirements with prompt dependency support ([#216](https://github.com/AksharP5/skillsync/issues/216)) ([d57d6ad](https://github.com/AksharP5/skillsync/commit/d57d6ad1562eeafea78dce53353edf8e2a569c2c))
* apply pulled changes before retrying a sync push ([#107](https://github.com/AksharP5/skillsync/issues/107)) ([869c004](https://github.com/AksharP5/skillsync/commit/869c0049e1e49585292605237bc7634e5de7e87c))
* clear remote assignments when deleting from a stale vault ([#153](https://github.com/AksharP5/skillsync/issues/153)) ([307ddeb](https://github.com/AksharP5/skillsync/commit/307ddeb66ae3d9567ce82594ed1e795900e648f9))
* **cli:** report pending plugin profile assignments accurately ([#105](https://github.com/AksharP5/skillsync/issues/105)) ([e3e3859](https://github.com/AksharP5/skillsync/commit/e3e3859bef8a1fde32053b9cec365fe4756988aa))
* **cli:** suggest unlinked instruction paths in settings ([#121](https://github.com/AksharP5/skillsync/issues/121)) ([bcbe710](https://github.com/AksharP5/skillsync/commit/bcbe71029a3e31df69c6ee638b9aa27a7f47b2bb))
* confirm eligible local folders before vault updates ([#200](https://github.com/AksharP5/skillsync/issues/200)) ([ab4c33b](https://github.com/AksharP5/skillsync/commit/ab4c33b679b80d332e79c9738b0b7c2f6b4d974e))
* consolidate imported and auto-adopted skills through directory aliases ([#197](https://github.com/AksharP5/skillsync/issues/197)) ([5ddc8a5](https://github.com/AksharP5/skillsync/commit/5ddc8a5f82bb8cd2ef4b41d54e92f773f90d462d))
* detect owned skill projections by their vault name ([#116](https://github.com/AksharP5/skillsync/issues/116)) ([21c4a85](https://github.com/AksharP5/skillsync/commit/21c4a854dac087ee185c6f8d5385920b7067103e))
* detect tools using the running process PATH ([#177](https://github.com/AksharP5/skillsync/issues/177)) ([4abd99a](https://github.com/AksharP5/skillsync/commit/4abd99a228d6423a6221387541739aca68d94ca1))
* discover OpenCode skills in the XDG config directory ([#109](https://github.com/AksharP5/skillsync/issues/109)) ([54a83f7](https://github.com/AksharP5/skillsync/commit/54a83f7ea1db462956f04e40a939fc0e601fa434))
* fail safely on scan errors and invalid vault metadata ([#94](https://github.com/AksharP5/skillsync/issues/94)) ([62080a7](https://github.com/AksharP5/skillsync/commit/62080a785e3a7ccb4d5c8c15faf8747c4c9b3a30))
* follow configuration changes in background sync ([#171](https://github.com/AksharP5/skillsync/issues/171)) ([28b427e](https://github.com/AksharP5/skillsync/commit/28b427e9c6ec0660d5567da122bf0689ecda66c9))
* honor local sources and renamed skill assignments ([#91](https://github.com/AksharP5/skillsync/issues/91)) ([da749ad](https://github.com/AksharP5/skillsync/commit/da749ad180313c7f43d84d2582b1c81947264f00))
* import new agent skills alongside managed copies ([#159](https://github.com/AksharP5/skillsync/issues/159)) ([afedd66](https://github.com/AksharP5/skillsync/commit/afedd666c4b6879bcfdd5eae26179632fec2e83a))
* install Linux services in the XDG config directory ([#101](https://github.com/AksharP5/skillsync/issues/101)) ([4762cbe](https://github.com/AksharP5/skillsync/commit/4762cbe1e42e66b08c043f7d54cc0a4223a227b4))
* keep configured paths stable across working directories ([#99](https://github.com/AksharP5/skillsync/issues/99)) ([262b140](https://github.com/AksharP5/skillsync/commit/262b140f1e66f1db42a00bc28b73a6cc1d58ed9c))
* keep Cursor rules stable through directory aliases ([#123](https://github.com/AksharP5/skillsync/issues/123)) ([e45c411](https://github.com/AksharP5/skillsync/commit/e45c4119e23834711a761fbd857def2256649c4e))
* keep declined skill selections from installing later ([#145](https://github.com/AksharP5/skillsync/issues/145)) ([e6f169f](https://github.com/AksharP5/skillsync/commit/e6f169f5ddaef4ed2f175d326fa5d23291f8a5e5))
* keep device identity when rerunning setup or connect ([#169](https://github.com/AksharP5/skillsync/issues/169)) ([d3b88cf](https://github.com/AksharP5/skillsync/commit/d3b88cf3bd86a8902db8a3db418d604947f191c9))
* keep failed instruction forks retryable ([#206](https://github.com/AksharP5/skillsync/issues/206)) ([b5b14f9](https://github.com/AksharP5/skillsync/commit/b5b14f97bb4fa23dadfc592373378c1054d95776))
* keep failed instruction profile creation retryable ([#143](https://github.com/AksharP5/skillsync/issues/143)) ([64033c6](https://github.com/AksharP5/skillsync/commit/64033c6781b0894961025fb1fea940c0afee995a))
* keep failed local skill adoption retryable ([#208](https://github.com/AksharP5/skillsync/issues/208)) ([91a825b](https://github.com/AksharP5/skillsync/commit/91a825be51810d79c12fb9dd410e652d15b0cb31))
* keep instruction destinations stable across directories ([#103](https://github.com/AksharP5/skillsync/issues/103)) ([8df5501](https://github.com/AksharP5/skillsync/commit/8df5501eacd8e4d6830a8b0513163984335f6573))
* keep pack listing from rewriting vault files ([#179](https://github.com/AksharP5/skillsync/issues/179)) ([3c43b28](https://github.com/AksharP5/skillsync/commit/3c43b28ac64f26c0a7f5edc0850644b1c575ac38))
* keep read-only skill copies recoverable during sync ([#128](https://github.com/AksharP5/skillsync/issues/128)) ([e101880](https://github.com/AksharP5/skillsync/commit/e101880be697ff51f96f55877f20093dc8705d9c))
* keep remote skill names stable and honor name overrides ([#97](https://github.com/AksharP5/skillsync/issues/97)) ([cf90147](https://github.com/AksharP5/skillsync/commit/cf9014731ae10cddbbc715fdd8f4ad107405a7b5))
* keep sync working after remote skill deletion ([#125](https://github.com/AksharP5/skillsync/issues/125)) ([96c7a72](https://github.com/AksharP5/skillsync/commit/96c7a72524098ede0982473a6c757e84adfa1845))
* keep target folders consistent with managed projections ([#87](https://github.com/AksharP5/skillsync/issues/87)) ([c62a88a](https://github.com/AksharP5/skillsync/commit/c62a88a64ae8a9c4acc1f0dd00976ecaeb2ec19b))
* keep Unicode Git paths from corrupting skill hashes ([#195](https://github.com/AksharP5/skillsync/issues/195)) ([4cdbe30](https://github.com/AksharP5/skillsync/commit/4cdbe30b03209a0a7537c9ad325d4ecf3c1bf67b))
* keep vault skills recoverable during deletion ([#155](https://github.com/AksharP5/skillsync/issues/155)) ([c77589e](https://github.com/AksharP5/skillsync/commit/c77589e552f5de06aaf13d82ae6131f4a44ab6cf))
* preflight target moves before removing working projections ([#198](https://github.com/AksharP5/skillsync/issues/198)) ([e8a503a](https://github.com/AksharP5/skillsync/commit/e8a503a6c3af93a8df4451d1d1c6a47894de0027))
* preserve active instructions through setup failures ([#203](https://github.com/AksharP5/skillsync/issues/203)) ([c8eed9a](https://github.com/AksharP5/skillsync/commit/c8eed9ad4eaa4a851c21eceba1163f62bc641b96))
* preserve complete Cursor rules when refresh fails ([#183](https://github.com/AksharP5/skillsync/issues/183)) ([e246b43](https://github.com/AksharP5/skillsync/commit/e246b43fb16663ed33ce00fbf2fc80ce2fb13895))
* preserve concurrent assignments when applying matrix edits ([#151](https://github.com/AksharP5/skillsync/issues/151)) ([f012bb6](https://github.com/AksharP5/skillsync/commit/f012bb655de9404a1e8808d244f2521c692150d5))
* preserve every local skill path in adoption baselines ([#115](https://github.com/AksharP5/skillsync/issues/115)) ([68bd001](https://github.com/AksharP5/skillsync/commit/68bd001ff34f4d6be8c03e0e67d6c36fa4774d4b))
* preserve exclusive apply locks during recovery ([#196](https://github.com/AksharP5/skillsync/issues/196)) ([7939606](https://github.com/AksharP5/skillsync/commit/7939606039665f0361ef1d30a2b01d696b911cba))
* preserve instructions after interrupted profile switches ([#85](https://github.com/AksharP5/skillsync/issues/85)) ([633a458](https://github.com/AksharP5/skillsync/commit/633a45832db984888ba3281c32aed6fcf2e1bd8a))
* preserve instructions when detaching a managed link fails ([#135](https://github.com/AksharP5/skillsync/issues/135)) ([db971f2](https://github.com/AksharP5/skillsync/commit/db971f2544247b8a4ce8b111df64c1af40560685))
* preserve legacy assignments when deleting a skill ([#117](https://github.com/AksharP5/skillsync/issues/117)) ([5555169](https://github.com/AksharP5/skillsync/commit/5555169b01f543878c3e7a4ca2b96c489dbbde6d))
* preserve literal installation paths in systemd services ([#215](https://github.com/AksharP5/skillsync/issues/215)) ([72e6ca2](https://github.com/AksharP5/skillsync/commit/72e6ca2129dec71c863560555e41c5d7a587e57c))
* preserve percent signs in Linux service paths ([#133](https://github.com/AksharP5/skillsync/issues/133)) ([f17cc4e](https://github.com/AksharP5/skillsync/commit/f17cc4eb98c5a1723b6e16e6a1a0d1dc89f80aff))
* preserve plugin reports when inventory is malformed ([#90](https://github.com/AksharP5/skillsync/issues/90)) ([792c5d6](https://github.com/AksharP5/skillsync/commit/792c5d62d1b79d938cb82bda9f84b7cac92a81f5))
* preserve relative links in projection backups ([#149](https://github.com/AksharP5/skillsync/issues/149)) ([3d16e1d](https://github.com/AksharP5/skillsync/commit/3d16e1d8b5737c0a9b3edc0bfa476d55b38f1e7e))
* preserve replacement files during read-only cleanup ([#209](https://github.com/AksharP5/skillsync/issues/209)) ([afad5ec](https://github.com/AksharP5/skillsync/commit/afad5ec45d74012700e1958a161a878da1ef686d))
* preserve standalone skills when removal lacks permission ([#199](https://github.com/AksharP5/skillsync/issues/199)) ([856848c](https://github.com/AksharP5/skillsync/commit/856848c65f7468f449c83053915ef267013375e5))
* preserve vault history for identical targeted adds ([#194](https://github.com/AksharP5/skillsync/issues/194)) ([b46cfed](https://github.com/AksharP5/skillsync/commit/b46cfed7ac0c9bb3da60f0c279252185fadf076a))
* preserve vault skills during failed overwrites ([#114](https://github.com/AksharP5/skillsync/issues/114)) ([49d0949](https://github.com/AksharP5/skillsync/commit/49d0949149f6a835302fa365aafb80db83683d27))
* prevent descendant pipes from stalling subprocess timeouts ([#219](https://github.com/AksharP5/skillsync/issues/219)) ([1b3dbcd](https://github.com/AksharP5/skillsync/commit/1b3dbcdc7634606d304630260952bb6e9a130bf4))
* recover stale vaults when rerunning setup ([#147](https://github.com/AksharP5/skillsync/issues/147)) ([56725e4](https://github.com/AksharP5/skillsync/commit/56725e48717e1288edbb336781e9fa889552ea27))
* reject empty uninstall destinations before removal ([#175](https://github.com/AksharP5/skillsync/issues/175)) ([8027a5c](https://github.com/AksharP5/skillsync/commit/8027a5c7e84ddd91fba89e0523d5b3458e3a7933))
* reject invalid device state before removing skills ([#96](https://github.com/AksharP5/skillsync/issues/96)) ([35b8ee7](https://github.com/AksharP5/skillsync/commit/35b8ee7bbc66f3a92f7175ea0e4d4849df26e655))
* reject invalid group config before replacing packs ([#181](https://github.com/AksharP5/skillsync/issues/181)) ([d5d85a4](https://github.com/AksharP5/skillsync/commit/d5d85a424ef91dc428a673d4bf9721dcef1a3f87))
* reject malformed config before selecting a vault ([#89](https://github.com/AksharP5/skillsync/issues/89)) ([e309a05](https://github.com/AksharP5/skillsync/commit/e309a0597bc47316389d33f2c6da851bc8c217fb))
* reject overflowing daemon intervals ([#213](https://github.com/AksharP5/skillsync/issues/213)) ([3675fcf](https://github.com/AksharP5/skillsync/commit/3675fcf39d515ba7b687990d9ea0d7d645f44595))
* reject pack objects without skill lists ([#204](https://github.com/AksharP5/skillsync/issues/204)) ([773e141](https://github.com/AksharP5/skillsync/commit/773e141b3de367bf756112687a0a27682a22f29a))
* reject target names reserved for global installs ([#124](https://github.com/AksharP5/skillsync/issues/124)) ([e3d6096](https://github.com/AksharP5/skillsync/commit/e3d60967eae806f6f455fab3102d5cf74a9a68e3))
* reject unsupported Claude instructions unlink ([#163](https://github.com/AksharP5/skillsync/issues/163)) ([f726618](https://github.com/AksharP5/skillsync/commit/f726618fcc478418c70c2916047424d2529a90d2))
* remove obsolete generated skill packs ([#88](https://github.com/AksharP5/skillsync/issues/88)) ([760abad](https://github.com/AksharP5/skillsync/commit/760abadc188ec416885cd3834d9d83863031eb46))
* report plugin directory read failures ([#185](https://github.com/AksharP5/skillsync/issues/185)) ([34a5858](https://github.com/AksharP5/skillsync/commit/34a585831f97ce29af340d66d33d8018136e390e))
* report source discovery errors before importing skills ([#165](https://github.com/AksharP5/skillsync/issues/165)) ([1431a6a](https://github.com/AksharP5/skillsync/commit/1431a6ad3d013f683ee1b802f5639eea41c3022d))
* restore target state when persistence fails ([#130](https://github.com/AksharP5/skillsync/issues/130)) ([381ea9c](https://github.com/AksharP5/skillsync/commit/381ea9c7630cbde75990577217289d33b570d47a))
* retry failed backups after remote skill deletions ([#137](https://github.com/AksharP5/skillsync/issues/137)) ([4f8c02c](https://github.com/AksharP5/skillsync/commit/4f8c02c55a8a85d4ce0336d6f284f7803e23455e))
* show remote instruction disables as pending until applied ([#161](https://github.com/AksharP5/skillsync/issues/161)) ([f6bd744](https://github.com/AksharP5/skillsync/commit/f6bd7444752744f09b26581f498ba73104a03af2))
* skip directories when choosing the service executable ([#157](https://github.com/AksharP5/skillsync/issues/157)) ([c2985f7](https://github.com/AksharP5/skillsync/commit/c2985f7b93c591e10e1dea3a133194b6b0f91f2e))
* stop skipping standalone folders during uninstall ([#131](https://github.com/AksharP5/skillsync/issues/131)) ([28a557d](https://github.com/AksharP5/skillsync/commit/28a557d5da1f7031c5553b314c60b51a730a7e93))
* stop sync before committing unresolved Git conflicts ([#84](https://github.com/AksharP5/skillsync/issues/84)) ([8b81705](https://github.com/AksharP5/skillsync/commit/8b8170532160e72912fffd0a90726f7e1c79dd60))
* sync executable permissions in managed skill copies ([#95](https://github.com/AksharP5/skillsync/issues/95)) ([41d150f](https://github.com/AksharP5/skillsync/commit/41d150ffe7a2681c451a5544426a7806f63387df))
* validate saved assignments before deleting vault skills ([#201](https://github.com/AksharP5/skillsync/issues/201)) ([9e34c38](https://github.com/AksharP5/skillsync/commit/9e34c381283bb2795e640dc93ac59d50853ecade))


### Performance Improvements

* cut large skill matrix rendering time by 99% ([#141](https://github.com/AksharP5/skillsync/issues/141)) ([b297041](https://github.com/AksharP5/skillsync/commit/b297041a928ab4fe746dddfa71c0599c5a83bfbb))
* cut repeated Git path spawns during sync ([#214](https://github.com/AksharP5/skillsync/issues/214)) ([569a5bb](https://github.com/AksharP5/skillsync/commit/569a5bb679a2de5bc83457cdde033af31fd9b77e))
* cut repeated reads when checking installed copies ([#167](https://github.com/AksharP5/skillsync/issues/167)) ([4ef2f76](https://github.com/AksharP5/skillsync/commit/4ef2f76544a2aab7ec517382bc4dd02b1911d78f))
* cut repeated reads when syncing multiple copy targets ([#139](https://github.com/AksharP5/skillsync/issues/139)) ([30fbbef](https://github.com/AksharP5/skillsync/commit/30fbbefbbd9372a4669fadf71edf2db82de664a3))
* initialize the vault once when listing devices ([#212](https://github.com/AksharP5/skillsync/issues/212)) ([0811a50](https://github.com/AksharP5/skillsync/commit/0811a5027d2f551ba4bd4c4f9cb1afe9ed407319))
* load interactive prompts only when needed ([#218](https://github.com/AksharP5/skillsync/issues/218)) ([3ce25fc](https://github.com/AksharP5/skillsync/commit/3ce25fccd0b097a9eadcfa613f2f9e611b1d809a))
* read JSON once during vault checks ([#211](https://github.com/AksharP5/skillsync/issues/211)) ([5e450b0](https://github.com/AksharP5/skillsync/commit/5e450b0ddd74935305c4ee9a861d282278ae27bb))
* skip unchanged device state writes during sync ([#210](https://github.com/AksharP5/skillsync/issues/210)) ([4c92923](https://github.com/AksharP5/skillsync/commit/4c9292382a846e87e5fd568bad89134df7d4f75d))
* skip unchanged plugin report writes ([#217](https://github.com/AksharP5/skillsync/issues/217)) ([ee6a1f9](https://github.com/AksharP5/skillsync/commit/ee6a1f9edc32bdd3c8f5db94db1f896dc7e62065))
* speed up idle sync by skipping redundant scans ([#92](https://github.com/AksharP5/skillsync/issues/92)) ([bdf1e94](https://github.com/AksharP5/skillsync/commit/bdf1e94476620bf6cdb6dd25035ee0fb1a99c458))
* speed up skill hashing in vaults with ignored files ([#173](https://github.com/AksharP5/skillsync/issues/173)) ([5f54eaf](https://github.com/AksharP5/skillsync/commit/5f54eaf0057db8a886c7adfe68a66659f93820d1))
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
