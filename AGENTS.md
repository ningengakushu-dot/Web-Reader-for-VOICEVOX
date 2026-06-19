# AGENTS.md

縺薙・繝ｪ繝昴ず繝医Μ縺ｧ縺ｯ縲∵律譛ｬ縺ｮ荳闊ｬ逧・↑髢狗匱莨夂､ｾ縺ｮ驕狗畑縺ｫ蟇・○縺ｦ縲∽ｽ懈･ｭ蜊倅ｽ阪＃縺ｨ縺ｫ繝悶Λ繝ｳ繝√ｒ菴懈・縺励∵э蜻ｳ縺ｮ縺ゅｋ蜊倅ｽ阪〒繧ｳ繝溘ャ繝医☆繧九・
## 髢狗匱驕狗畑

- 譌｢蟄倥・譛ｪ繧ｳ繝溘ャ繝亥､画峩繧貞享謇九↓謌ｻ縺輔↑縺・・- 繝舌げ菫ｮ豁｣縺ｧ縺ｯ縲∝次蝗蛻・梵縲∝ｮ溯｣・∵､懆ｨｼ縲√Ξ繝薙Η繝ｼ繧貞・縺代※閠・∴繧九・- 螟画峩蠕後・譛菴朱剞縲～manifest.json` 縺ｮ JSON parse 縺ｨ荳ｻ隕・JavaScript 縺ｮ讒区枚繝√ぉ繝・け繧定｡後≧縲・- push 繧・merge 縺ｯ縲∽ｽ懈･ｭ蜀・ｮｹ縺ｨ繝ｪ繧ｹ繧ｯ縺瑚ｪｬ譏弱〒縺阪ｋ迥ｶ諷九〒陦後≧縲・
## 閾ｪ蜍募喧繝ｫ繝ｼ繝・
- Claude Code 縺ｯ螳溯｣・球蠖薙，odex 縺ｯ謖・､ｺ繝ｻ繝ｬ繝薙Η繝ｼ諡・ｽ薙→縺励※謇ｱ縺・・- Claude Code 縺ｫ縺ｯ `scripts/agent-loop.ps1` 邨檎罰縺ｧ萓晞ｼ縺吶ｋ縲・- Codex hook 縺ｯ `.codex/run-agent-loop.flag` 縺悟ｭ伜惠縺吶ｋ蝣ｴ蜷医・縺ｿ閾ｪ蜍募喧繝ｫ繝ｼ繝励ｒ襍ｷ蜍輔☆繧九・- hook 縺ｯ螳牙・陬・ｽｮ縺ｧ縺ゅｊ縲・壼ｸｸ縺ｮ莨夊ｩｱ邨ゆｺ・凾縺ｫ蜍晄焔縺ｫ菫ｮ豁｣菴懈･ｭ繧帝幕蟋九＠縺ｦ縺ｯ縺・￠縺ｪ縺・・
## 讀懆ｨｼ繧ｳ繝槭Φ繝・
```powershell
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest json ok')"
node --check background.js
node --check content.js
node --check offscreen.js
node --check options.js
git diff --check
```
