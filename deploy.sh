#!/usr/bin/env bash
# The Third Shelf → Cloudflare Pages (shelf.keystonehub.io)
#
# 배포본은 작업 트리가 아니라 HEAD 커밋에서 꺼낸다. `git archive` 로 index.html,
# _headers, assets/ 를 그대로 뽑아 올리므로 배포된 사이트는 언제나 특정 커밋과
# 일치하고, 커밋하지 않은 수정이나 임시 파일이 실수로 공개되지 않는다. 파일을
# 작업 트리에서 읽지 않으니 검사와 복사 사이에 경로가 바뀌는 경합도 없다.
#
# 저장소 루트를 통째로 올릴 수 없는 이유는 assets/plates 와 assets/gen 에 약
# 118MB 의 로컬 작업 아트가 있기 때문인데, 그 경계는 .gitignore 가 이미 긋고
# 있다. 커밋에 없는 파일은 애초에 아카이브에 들어오지 않는다.
#
#   npm ci                   최초 1회 — lockfile 에 고정된 wrangler 설치
#   ./deploy.sh              HEAD 커밋을 프로덕션에 배포
#   ./deploy.sh --dry-run    스테이징 결과만 확인하고 업로드 안 함
set -euo pipefail

PROJECT="${CF_PAGES_PROJECT:-complete-shelf}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$(mktemp -d "${TMPDIR:-/tmp}/complete-shelf-dist.XXXXXX")"
trap 'rm -rf "$DIST"' EXIT

DRY_RUN=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=1
      ;;
    # wrangler 는 같은 옵션이 두 번 오면 뒤엣값을 쓴다. 이 둘이 덮이면 엉뚱한
    # 프로젝트나 preview 로 나가면서 성공 메시지는 그대로 뜬다.
    --project-name|--project-name=*|--branch|--branch=*)
      echo "이 옵션은 스크립트가 정합니다: $arg" >&2
      echo "  프로젝트는 CF_PAGES_PROJECT, 브랜치는 CF_PAGES_PRODUCTION_BRANCH 로 바꾸세요." >&2
      exit 2
      ;;
    *)
      ARGS+=("$arg")
      ;;
  esac
done

cd "$ROOT"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "git 저장소가 아닙니다 — 배포 대상을 판별할 수 없어 중단합니다." >&2
  exit 2
fi

# --- 스테이징 (HEAD 커밋에서) ---------------------------------------------
PATHS=(index.html assets)
if git cat-file -e HEAD:_headers 2>/dev/null; then
  PATHS+=(_headers)
else
  echo "알림: HEAD 에 _headers 가 없어 캐시·보안 헤더 없이 배포됩니다." >&2
fi

git archive --format=tar HEAD -- "${PATHS[@]}" | tar -x -C "$DIST"

# 커밋에 있는지가 아니라 아카이브에 실제로 나왔는지를 본다. .gitattributes 의
# export-ignore 는 커밋된 파일도 아카이브에서 빼는데, 그러면 진입 페이지 없는
# 사이트가 배포 성공으로 올라간다.
[ -f "$DIST/index.html" ] || {
  echo "아카이브에 index.html 이 없습니다 — 배포를 중단합니다." >&2
  echo "  .gitattributes 의 export-ignore 설정을 확인하세요." >&2
  exit 2
}

# git 은 심볼릭 링크도 커밋할 수 있고, 아카이브는 그것을 링크 그대로 풀어놓는다.
# 업로드 단계에서 링크를 따라가면 저장소 밖 파일이 공개되므로 여기서 끊는다.
# DIST 는 방금 만든 비공개 임시 디렉토리라 이 검사와 업로드 사이에 경합이 없다.
if [ -n "$(find "$DIST" -type l -print -quit)" ]; then
  echo "커밋에 심볼릭 링크가 포함돼 있어 배포를 중단합니다:" >&2
  find "$DIST" -type l | sed "s|$DIST/|  |" >&2
  exit 2
fi

staged="$(find "$DIST" -type f | wc -l | tr -d ' ')"
if [ "$staged" -eq 0 ]; then
  echo "아카이브가 비어 있습니다 — 배포를 중단합니다." >&2
  exit 2
fi

echo "스테이징 완료: $DIST (HEAD 커밋 기준, 파일 $staged 개)"
find "$DIST" -type f | sed "s|$DIST/|  |"
du -sh "$DIST" | sed 's/^/  총 /'

# 커밋하지 않은 변경은 배포에 반영되지 않는다. 조용히 빠지면 "왜 안 바뀌지" 가 된다.
if ! git diff --quiet HEAD -- index.html _headers assets 2>/dev/null; then
  echo "알림: 커밋되지 않은 변경은 이번 배포에 포함되지 않습니다." >&2
fi
while IFS= read -r -d '' path; do
  echo "알림: 커밋되지 않아 배포에서 빠집니다 — $path" >&2
done < <(git ls-files --others --exclude-standard -z assets)

if [ "$DRY_RUN" -eq 1 ]; then
  echo "--dry-run: 업로드하지 않고 종료합니다."
  exit 0
fi

# --- 배포 -----------------------------------------------------------------
# 프로덕션에는 병합된 내용만 올린다. 아무 feature 커밋에서나 올리면 리뷰를 거치지
# 않은 상태가 라이브가 되고, 라이브가 어느 커밋인지도 브랜치로 추적할 수 없다.
PRODUCTION_BRANCH="${CF_PAGES_PRODUCTION_BRANCH:-main}"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" != "$PRODUCTION_BRANCH" ] && [ "${CF_PAGES_ALLOW_ANY_BRANCH:-0}" != "1" ]; then
  echo "프로덕션 배포는 $PRODUCTION_BRANCH 에서만 합니다 (현재: $CURRENT_BRANCH)." >&2
  echo "  먼저 병합하거나, 의도한 것이면 CF_PAGES_ALLOW_ANY_BRANCH=1 로 실행하세요." >&2
  exit 2
fi

# wrangler 는 package-lock.json 에 버전과 integrity 해시로 고정돼 있다.
# `npx wrangler` 는 로컬에 없으면 레지스트리에서 그때그때 최신본을 받아 실행하는데,
# 이 스크립트는 Cloudflare 배포 권한을 들고 돌기 때문에 그 경로를 열어두지 않는다.
WRANGLER="$ROOT/node_modules/.bin/wrangler"
if [ ! -x "$WRANGLER" ]; then
  echo "wrangler 가 없습니다 — 'npm ci' 를 먼저 실행하세요." >&2
  echo "  lockfile 에 고정된 버전만 쓰고, 레지스트리 최신본 자동 실행은 막습니다." >&2
  exit 2
fi

# --branch 는 현재 git 브랜치가 아니라 Pages 의 프로덕션 브랜치 이름이다.
# 이 값이 프로덕션 브랜치와 다르면 preview 배포가 되어 shelf.keystonehub.io 는
# 갱신되지 않는다. 그래서 어느 브랜치에서 실행하든 프로덕션 이름으로 올린다.
"$WRANGLER" pages deploy "$DIST" \
  --project-name "$PROJECT" \
  --branch "${CF_PAGES_PRODUCTION_BRANCH:-main}" \
  ${ARGS[@]+"${ARGS[@]}"}
