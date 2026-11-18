# Quy chuẩn phát triển HoangMinh Store

## SEO Alpha Research Gate — mandatory for SEO (2026-11-18)

Before ANY SEO/AEO/GEO task, organic article creation, title/meta change, internal linking, structured data or indexing change, bootstrap from the latest accessible `capquangfptminhlh/seo-web@main` (private central repository) and record the resolved source commit SHA + observed_at. Read the full `governance/website-os.manifest.yml#mandatory_read_order`, including:

- `standards/Website_OS_SEO_Alpha_Research_Gate_v1.0.0.md`
- `governance/seo-alpha-policy.yml`
- `alpha-engine/README.md`
- `alpha-engine/lab/README.md` (SEO-specific conditional reading)

Record the actual standard SHA-256 and current source SHA in `.website-os/evidence/seo-alpha-bootstrap.yml`. Invoke central `scripts/verify-seo-alpha-contract.py` when the repository is available. If the source, file, or read evidence is unavailable or stale: **HOLD — SEO ALPHA RESEARCH GATE NOT LOADED**; no SEO edits or claims. Lab output is read-only research, not permission to publish. Two human reviewers + owner approval are required before any SEO experiment reaches production. This section only strengthens existing project and Website OS safeguards; do not bypass local business, privacy, build, or release gates. If a pre-existing local auto-push rule conflicts, SEO-specific production approval and hard gates take precedence.


## 1. Tự động lưu & đẩy mã nguồn lên GitHub (Bắt buộc)
- Sau khi hoàn thành bất kỳ chỉnh sửa, sửa lỗi (bugfix) hoặc cập nhật tính năng nào, agent **bắt buộc phải tự động**:
  1. Chạy bộ kiểm thử để bảo đảm hệ thống không lỗi (`npm test` và `npm run test:ui`).
  2. Gom các file mã nguồn đã chỉnh sửa (chỉ `git add` các file code/css/html/js liên quan).
  3. Tạo commit với nội dung rõ ràng, chuẩn Conventional Commits.
  4. Đẩy thẳng lên GitHub (`git push origin main`) ngay lập tức, không đợi nhắc nhở.

## 2. Bảo mật & Quy tắc Commit
- **TUYỆT ĐỐI KHÔNG** commit các file dữ liệu runtime hoặc bí mật:
  - Thư mục `data/` (`data/products.json`, `data/techmall_products.json`, `data/orders.json`, `data/zalo-bot.json`, ...)
  - File môi trường `.env` hoặc các tệp cấu hình chứa API key / token bí mật.
- Luôn tuân thủ cơ chế chống lộ nguồn hàng (Anti-Leak):
  - Không lộ tên nhà cung cấp, URL nguồn sỉ ra frontend, robots.txt, CDN công khai.
  - Luôn đi qua proxy ảnh `/cdn` nội bộ của cửa hàng.
