#!/usr/bin/env bash

# Exit script if command fails or uninitialized variables used
set -euo pipefail

# ==================================
# Verify repo is clean
# ==================================

# List uncommitted changes and
# check if the output is not empty
if [ -n "$(git status --porcelain)" ]; then
  # Print error message
  printf "\nError: repo has uncommitted changes\n\n"
  # Exit with error code
  exit 1
fi

# ==================================
# Get latest version from git tags
# ==================================

# List git tags sorted lexicographically
# so version numbers sorted correctly
GIT_TAGS=$(git tag --sort=version:refname)

# Get last line of output which returns the
# last tag (most recent version)
GIT_TAG_LATEST=$(echo "$GIT_TAGS" | tail -n 1)

# If no tag found, default to v0.0.0
if [ -z "$GIT_TAG_LATEST" ]; then
  GIT_TAG_LATEST="v0.0.0"
fi

# Strip prefix 'v' from the tag to easily increment
GIT_TAG_LATEST=$(echo "$GIT_TAG_LATEST" | sed 's/^v//')

# ==================================
# Increment version number
# ==================================

# Get version type from first argument passed to script
VERSION_TYPE="${1-}"
VERSION_NEXT=""

if [ "$VERSION_TYPE" = "patch" ]; then
  # Increment patch version
  VERSION_NEXT="$(echo "$GIT_TAG_LATEST" | awk -F. '{$NF++; print $1"."$2"."$NF}')"
elif [ "$VERSION_TYPE" = "minor" ]; then
  # Increment minor version
  VERSION_NEXT="$(echo "$GIT_TAG_LATEST" | awk -F. '{$2++; $3=0; print $1"."$2"."$3}')"
elif [ "$VERSION_TYPE" = "major" ]; then
  # Increment major version
  VERSION_NEXT="$(echo "$GIT_TAG_LATEST" | awk -F. '{$1++; $2=0; $3=0; print $1"."$2"."$3}')"
else
  # Print error for unknown versioning type
  printf "\nError: invalid VERSION_TYPE arg passed, must be 'patch', 'minor' or 'major'\n\n"
  # Exit with error code
  exit 1
fi

# ==================================
# Update version.json file
# ==================================

# Example version.json:
# {
#  "version": "0.0.298", "major": 0, "minor": 0, "patch": 298, "build_date_iso_8601": "2024-08-03T00:00:00-07:00", "git_sha": "84e255ddf357386afc98f8217bb52c8515ff9072"
#}

# Update version number in version.json
jq ".version = \"$VERSION_NEXT\"" version.json >version.json.tmp
mv version.json.tmp version.json

# Update build number in version.json
MAJOR=$(echo "$VERSION_NEXT" | awk -F. '{print $1}')
MINOR=$(echo "$VERSION_NEXT" | awk -F. '{print $2}')
PATCH=$(echo "$VERSION_NEXT" | awk -F. '{print $3}')
jq ".major = $MAJOR | .minor = $MINOR | .patch = $PATCH" version.json >version.json.tmp
mv version.json.tmp version.json

# Update build date in version.json
jq ".build_date_iso_8601 = \"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"" version.json >version.json.tmp
mv version.json.tmp version.json

# Update git sha in version.json
GIT_SHA=$(git rev-parse --short HEAD)
jq ".git_sha = \"$GIT_SHA\"" version.json >version.json.tmp
mv version.json.tmp version.json

# Commit the changes
git add version.json
git commit -m "build: bump version.json - v$VERSION_NEXT"

# ==================================
# Create git tag for new version
# ==================================

# Create an annotated tag
git tag -a "v$VERSION_NEXT" -m "Release: v$VERSION_NEXT"

# Optional: push commits and tag to remote 'main' branch
git push origin main --follow-tags
