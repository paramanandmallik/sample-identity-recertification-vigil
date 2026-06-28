#!/usr/bin/env python3
"""
clean-demo-data.py - wipe all items from the RecertEngine DynamoDB table so the
demo starts from a clean slate (removes stale/duplicate cycles, review items, and
decisions). Dry-run by default; pass --confirm to actually delete.

After running with --confirm, open the UI and click "Run Discovery" to create one
fresh cycle.

Usage:
  python3 clean-demo-data.py                 # dry run (counts only)
  python3 clean-demo-data.py --confirm       # actually delete
  python3 clean-demo-data.py --confirm --table RecertEngine-dev --region us-east-1
"""
import argparse
import boto3

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--table", default="RecertEngine-dev")
    ap.add_argument("--region", default="us-east-1")
    ap.add_argument("--confirm", action="store_true", help="actually delete (otherwise dry-run)")
    args = ap.parse_args()

    ddb = boto3.client("dynamodb", region_name=args.region)
    paginator = ddb.get_paginator("scan")
    keys = []
    by_type = {}
    for page in paginator.paginate(TableName=args.table, ProjectionExpression="PK,SK,entityType"):
        for it in page.get("Items", []):
            keys.append({"PK": it["PK"], "SK": it["SK"]})
            t = it.get("entityType", {}).get("S", "(none)")
            by_type[t] = by_type.get(t, 0) + 1

    print(f"Table {args.table} ({args.region}): {len(keys)} items")
    for t, n in sorted(by_type.items()):
        print(f"  {t}: {n}")

    if not args.confirm:
        print("\nDRY RUN. Re-run with --confirm to delete all of the above.")
        return

    deleted = 0
    for i in range(0, len(keys), 25):
        chunk = keys[i:i + 25]
        ddb.batch_write_item(RequestItems={
            args.table: [{"DeleteRequest": {"Key": k}} for k in chunk]
        })
        deleted += len(chunk)
    print(f"\nDeleted {deleted} items. Now open the UI and click 'Run Discovery' to seed one fresh cycle.")

if __name__ == "__main__":
    main()
