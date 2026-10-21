#!/usr/bin/env bash
# Read-only discovery. No resources, keys, permissions or secrets are created.
set -euo pipefail
if [[ $# -ne 2 ]]; then echo 'Usage: aws-plan.sh AWS_PROFILE AWS_REGION' >&2; exit 1; fi
profile=$1
region=$2
aws sts get-caller-identity --profile "$profile" --region "$region" --query '{Account:Account,Arn:Arn}' --output json
aws lightsail get-bundles --profile "$profile" --region "$region" --no-include-inactive --query 'bundles[?isActive==`true` && supportedPlatforms[0]==`LINUX_UNIX`].{id:bundleId,priceUsdMonthly:price,memoryGiB:ramSizeInGb,storageGiB:diskSizeInGb,publicIpv4:publicIpv4AddressCount}' --output json
aws lightsail get-blueprints --profile "$profile" --region "$region" --no-include-inactive --query 'blueprints[?isActive==`true` && type==`os`].{id:blueprintId,name:name,version:version}' --output json
aws lightsail get-instances --profile "$profile" --region "$region" --query 'instances[].{name:name,state:state.name,zone:location.availabilityZone}' --output json
