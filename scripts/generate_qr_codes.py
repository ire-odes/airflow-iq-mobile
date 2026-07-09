#!/usr/bin/env python3
"""
Generate QR codes for all Airflow IQ devices in Supabase.

Each QR code encodes the device MAC address as a plain uppercase string
(e.g. "A1B2C3D4E5F6"), which the mobile app reads and uses to claim the device.

Usage:
    # Generate QR images locally only
    python generate_qr_codes.py

    # Also upload images to Supabase Storage and write qr_code_url back to each device
    python generate_qr_codes.py --upload

Requirements:
    pip install -r requirements.txt

You need a Supabase service role key (NOT the anon key) to read all devices
and optionally write back to the database.
Find it at: Supabase Dashboard → Project Settings → API → service_role secret
"""
import os
import sys
import argparse
from pathlib import Path

try:
    import qrcode
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit("Missing dependency. Run: pip install -r requirements.txt")

try:
    from supabase import create_client
except ImportError:
    sys.exit("Missing dependency. Run: pip install -r requirements.txt")

SUPABASE_URL = "https://hniplnaohvcbtmelatnz.supabase.co"
STORAGE_BUCKET = "device-qr-codes"
OUTPUT_DIR = Path(__file__).parent / "qr_output"


def get_client(service_key: str):
    return create_client(SUPABASE_URL, service_key)


def fetch_devices(client) -> list[dict]:
    resp = client.table("devices").select("id, device_mac, name").execute()
    return resp.data or []


def make_qr_image(mac: str) -> Image.Image:
    qr = qrcode.QRCode(
        version=1,
        error_correction=qrcode.constants.ERROR_CORRECT_H,
        box_size=10,
        border=4,
    )
    qr.add_data(mac)
    qr.make(fit=True)
    return qr.make_image(fill_color="black", back_color="white").convert("RGB")


def add_label(img: Image.Image, mac: str, name: str) -> Image.Image:
    """Add a human-readable MAC label below the QR code."""
    from PIL import ImageFont
    label_height = 40
    new_img = Image.new("RGB", (img.width, img.height + label_height), "white")
    new_img.paste(img, (0, 0))
    draw = ImageDraw.Draw(new_img)
    # Format MAC as AA:BB:CC:DD:EE:FF for readability
    formatted = ":".join(mac[i:i+2] for i in range(0, 12, 2))
    display = f"{name}  |  {formatted}" if name else formatted
    try:
        font = ImageFont.truetype("arial.ttf", 14)
    except Exception:
        font = ImageFont.load_default()
    bbox = draw.textbbox((0, 0), display, font=font)
    text_w = bbox[2] - bbox[0]
    x = (img.width - text_w) // 2
    draw.text((x, img.height + 8), display, fill="black", font=font)
    return new_img


def ensure_storage_bucket(client):
    """Create the storage bucket if it doesn't exist."""
    try:
        buckets = client.storage.list_buckets()
        names = [b.name for b in buckets]
        if STORAGE_BUCKET not in names:
            client.storage.create_bucket(STORAGE_BUCKET, options={"public": True})
            print(f"  Created storage bucket: {STORAGE_BUCKET}")
    except Exception as e:
        print(f"  Warning: could not check/create storage bucket: {e}")


def upload_qr(client, mac: str, image_path: Path) -> str | None:
    try:
        bucket = client.storage.from_(STORAGE_BUCKET)
        file_name = f"{mac}.png"
        with open(image_path, "rb") as f:
            bucket.upload(
                path=file_name,
                file=f,
                file_options={"content-type": "image/png", "upsert": "true"},
            )
        return bucket.get_public_url(file_name)
    except Exception as e:
        print(f"    Upload error: {e}")
        return None


def main():
    parser = argparse.ArgumentParser(
        description="Generate QR codes for Airflow IQ devices",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--upload",
        action="store_true",
        help="Upload QR images to Supabase Storage and save qr_code_url on each device",
    )
    parser.add_argument(
        "--key",
        metavar="SERVICE_KEY",
        help="Supabase service role key (or set SUPABASE_SERVICE_KEY env var)",
    )
    args = parser.parse_args()

    service_key = args.key or os.environ.get("SUPABASE_SERVICE_KEY")
    if not service_key:
        print("Error: Supabase service role key required.")
        print("  Pass it with --key, or set the SUPABASE_SERVICE_KEY environment variable.")
        print("  Find it at: Supabase Dashboard → Project Settings → API → service_role")
        sys.exit(1)

    client = get_client(service_key)
    OUTPUT_DIR.mkdir(exist_ok=True)

    print("Fetching devices from Supabase...")
    devices = fetch_devices(client)
    if not devices:
        print("No devices found.")
        return

    print(f"Found {len(devices)} device(s).\n")

    if args.upload:
        ensure_storage_bucket(client)

    skipped = 0
    for device in devices:
        mac = (device.get("device_mac") or "").strip().upper()
        name = (device.get("name") or "").strip()
        device_id = device["id"]

        if len(mac) != 12 or not mac.isalnum():
            print(f"  SKIP  {name or device_id!r} — invalid MAC: {mac!r}")
            skipped += 1
            continue

        safe_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in name) if name else "device"
        filename = f"{safe_name}_{mac}.png"
        output_path = OUTPUT_DIR / filename

        img = make_qr_image(mac)
        img = add_label(img, mac, name)
        img.save(output_path, format="PNG")
        print(f"  OK    {name or mac}  →  {filename}")

        if args.upload:
            url = upload_qr(client, mac, output_path)
            if url:
                client.table("devices").update({"qr_code_url": url}).eq("id", device_id).execute()
                print(f"        Uploaded → {url}")
            else:
                print(f"        Upload failed — local file kept at {output_path}")

    print(f"\nDone. QR codes saved to: {OUTPUT_DIR.resolve()}")
    if skipped:
        print(f"{skipped} device(s) skipped due to missing/invalid MAC address.")
    if not args.upload:
        print("\nTip: run with --upload to push QR images to Supabase Storage and")
        print("     save the public URL in the devices.qr_code_url column.")


if __name__ == "__main__":
    main()
