# Engine quality measurement, 2026-11-15

These measurements led to removing every engine except Anime4K (and the WebGPU renderer) on 2026-11-16. The other engines scored well here mostly because the overall score rewards staying close to the source; measured in the real extension they changed 0.0-0.3% of pixels noticeably, against 3-4% for Anime4K. `src/engine-rank.ts`, which held these scores, no longer exists. The harness in `test/test.ts` (`a4kQualityPreset`) and the metrics in `test/quality.ts` remain, now for `bilinear` and the Anime4K modes only.

## Method

- 53 frames of 1080p anime: 17 from One Piece episode 1120, 18 from Morevna Episode 3 (CC BY 4.0), 18 from Pepper & Carrot Episode 6 (CC BY 4.0). Near-black and near-flat frames were left out.
- Each frame was scaled to 960x540 (bicubic) and encoded with H.264 (x264, CRF 23), then upscaled 2x by every engine preset and compared with the 1080p original.
- `bilinear` is the browser's own scaling of the same input: the baseline.
- The frames are not in the repository.

## Scores (0-100, higher is better)

Overall = 35% faithful + 25% lines + 25% detail + 15% clean. Faithful is the PSNR gain over bilinear (50 = same as bilinear). The standard error of the overall score is about 1.5 points.

| Preset | Overall | Faithful | Lines | Detail | Clean | One Piece | Morevna | Pepper & Carrot |
|---|---|---|---|---|---|---|---|---|
| anime4k-gan S | 76.3 | 65 | 91 | 75 | 80 | 78.4 | 79.4 | 71.2 |
| anime4k-gan M | 74.2 | 64 | 90 | 69 | 80 | 77.4 | 77.0 | 68.2 |
| artcnn16 C4F16 | 73.2 | 74 | 90 | 51 | 82 | 71.8 | 74.7 | 72.9 |
| fsr soft | 73.0 | 70 | 85 | 60 | 81 | 70.0 | 73.7 | 75.2 |
| ravu r4 | 71.8 | 73 | 86 | 50 | 82 | 70.4 | 73.3 | 71.8 |
| artcnn16 C4F32 | 71.7 | 74 | 90 | 45 | 82 | 70.8 | 73.4 | 70.9 |
| ravu r3 | 71.6 | 73 | 86 | 49 | 82 | 69.9 | 73.1 | 71.6 |
| fsr normal | 71.5 | 65 | 90 | 58 | 79 | 73.7 | 73.2 | 67.7 |
| artcnn C4F32 | 71.3 | 72 | 90 | 45 | 82 | 70.6 | 73.7 | 69.5 |
| artcnn16 C4F32_DS | 71.1 | 77 | 94 | 32 | 83 | 72.7 | 73.4 | 67.4 |
| artcnn C4F16 | 71.0 | 72 | 90 | 44 | 81 | 70.4 | 73.0 | 69.4 |
| ravu r2 | 70.7 | 72 | 86 | 48 | 82 | 68.6 | 72.3 | 71.2 |
| artcnn C4F32_DS | 70.6 | 65 | 97 | 47 | 79 | 70.9 | 73.7 | 67.1 |
| artcnn C4F16_DS | 70.3 | 64 | 95 | 49 | 77 | 71.1 | 73.2 | 66.7 |
| artcnn16 C4F16_DS | 69.9 | 76 | 94 | 29 | 82 | 71.0 | 71.8 | 66.9 |
| anime4k C | 69.7 | 80 | 89 | 27 | 83 | 70.0 | 72.1 | 67.0 |
| fsrcnnx 8 | 69.5 | 72 | 89 | 40 | 82 | 69.7 | 71.3 | 67.4 |
| fsrcnnx 16 | 69.3 | 72 | 89 | 38 | 82 | 69.9 | 71.3 | 66.8 |
| fsr crisp | 66.3 | 59 | 92 | 46 | 75 | 70.8 | 70.9 | 57.5 |
| cas high | 64.8 | 48 | 83 | 64 | 76 | 63.2 | 62.1 | 69.1 |
| anime4k B | 63.7 | 58 | 95 | 29 | 81 | 66.7 | 67.3 | 57.3 |
| anime4k CA | 62.2 | 56 | 96 | 26 | 80 | 64.4 | 67.0 | 55.4 |
| anime4k A | 61.7 | 47 | 96 | 37 | 80 | 66.1 | 66.2 | 53.0 |
| cas mid | 61.0 | 54 | 79 | 41 | 80 | 58.7 | 56.7 | 67.4 |
| nnedi3 64 | 60.0 | 70 | 79 | 13 | 83 | 58.0 | 61.2 | 60.6 |
| nnedi3 32 | 60.0 | 70 | 79 | 13 | 83 | 57.9 | 61.2 | 60.7 |
| nnedi3 16 | 59.8 | 69 | 79 | 13 | 83 | 57.7 | 60.9 | 60.6 |
| cas low | 58.3 | 55 | 77 | 31 | 81 | 56.3 | 54.9 | 63.6 |
| anime4k-gan RM | 58.2 | 25 | 96 | 62 | 64 | 63.4 | 63.4 | 48.0 |
| anime4k BB | 56.5 | 37 | 96 | 31 | 79 | 58.1 | 61.6 | 49.9 |
| anime4k AA | 53.3 | 21 | 93 | 46 | 74 | 53.0 | 59.0 | 47.7 |
| bilinear | 49.7 | 50 | 71 | 9 | 82 | 46.8 | 51.0 | 51.1 |

## Raw measurements (mean over all frames)

Edge and detail are ratios to the original (1 = same as the original; above 1 = sharper or more texture than the original). Overshoot is in luma levels.

| Preset | PSNR (dB) | SSIM | Edge sharpness | Detail kept | Overshoot |
|---|---|---|---|---|---|
| anime4k-gan S | 36.17 | 0.9616 | 0.905 | 1.106 | 0.798 |
| anime4k-gan M | 36.08 | 0.9599 | 0.897 | 1.230 | 0.785 |
| artcnn16 C4F16 | 36.78 | 0.9671 | 0.896 | 0.735 | 0.728 |
| fsr soft | 36.43 | 0.9671 | 0.855 | 0.833 | 0.756 |
| ravu r4 | 36.66 | 0.9672 | 0.863 | 0.741 | 0.720 |
| artcnn16 C4F32 | 36.76 | 0.9673 | 0.897 | 0.703 | 0.731 |
| ravu r3 | 36.66 | 0.9672 | 0.862 | 0.733 | 0.720 |
| fsr normal | 36.11 | 0.9642 | 0.898 | 1.191 | 0.850 |
| artcnn C4F32 | 36.70 | 0.9669 | 0.898 | 0.697 | 0.737 |
| artcnn16 C4F32_DS | 37.15 | 0.9715 | 0.947 | 0.616 | 0.700 |
| artcnn C4F16 | 36.68 | 0.9668 | 0.898 | 0.693 | 0.740 |
| ravu r2 | 36.57 | 0.9671 | 0.855 | 0.719 | 0.714 |
| artcnn C4F32_DS | 36.17 | 0.9663 | 0.982 | 0.700 | 0.847 |
| artcnn C4F16_DS | 36.09 | 0.9645 | 0.967 | 0.745 | 0.908 |
| artcnn16 C4F16_DS | 37.06 | 0.9709 | 0.943 | 0.598 | 0.704 |
| anime4k C | 37.43 | 0.9717 | 0.892 | 0.586 | 0.686 |
| fsrcnnx 8 | 36.65 | 0.9665 | 0.888 | 0.668 | 0.731 |
| fsrcnnx 16 | 36.71 | 0.9669 | 0.892 | 0.652 | 0.739 |
| fsr crisp | 35.71 | 0.9609 | 0.926 | 1.471 | 1.002 |
| cas high | 34.98 | 0.9526 | 0.830 | 0.878 | 0.953 |
| anime4k B | 35.72 | 0.9691 | 0.993 | 0.584 | 0.744 |
| anime4k CA | 35.54 | 0.9680 | 0.999 | 0.564 | 0.802 |
| anime4k A | 34.85 | 0.9659 | 1.058 | 0.633 | 0.817 |
| cas mid | 35.38 | 0.9605 | 0.791 | 0.678 | 0.804 |
| nnedi3 64 | 36.44 | 0.9686 | 0.789 | 0.507 | 0.685 |
| nnedi3 32 | 36.43 | 0.9685 | 0.789 | 0.507 | 0.685 |
| nnedi3 16 | 36.41 | 0.9683 | 0.789 | 0.507 | 0.686 |
| cas low | 35.43 | 0.9621 | 0.773 | 0.613 | 0.770 |
| anime4k-gan RM | 33.20 | 0.9545 | 1.120 | 1.113 | 1.420 |
| anime4k BB | 34.14 | 0.9634 | 1.030 | 0.583 | 0.838 |
| anime4k AA | 32.45 | 0.9548 | 1.143 | 0.720 | 1.031 |
| bilinear | 35.11 | 0.9634 | 0.706 | 0.482 | 0.738 |

## Limits

- The weights are a judgement, not a measurement, and the faithfulness measure was changed from SSIM to PSNR after the first results (SSIM put every engine within 0.01 of bilinear).
- The detail measure counts texture energy; it cannot tell kept detail from invented detail.
- Comparing with the original penalises deliberate stylising such as Anime4K's line sharpening.
- Only 2x from 540p, anime only, three sources. Live action was not measured.
