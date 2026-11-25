import sys
import os
import subprocess
import asyncio

async def generate_speech(text, output_ogg_path, voice="en-US-EmmaMultilingualNeural"):
    import edge_tts
    
    temp_mp3 = output_ogg_path + ".tmp.mp3"
    try:
        communicate = edge_tts.Communicate(text, voice)
        await communicate.save(temp_mp3)
        
        # Convert MP3 to Telegram native Opus OGG using ffmpeg
        ffmpeg_cmd = [
            "ffmpeg", "-y",
            "-i", temp_mp3,
            "-c:a", "libopus",
            "-b:a", "32k",
            "-v", "error",
            output_ogg_path
        ]
        res = subprocess.run(ffmpeg_cmd, capture_output=True)
        if res.returncode != 0:
            # Fallback: if ffmpeg fails, use the mp3 file directly
            if os.path.exists(temp_mp3):
                os.replace(temp_mp3, output_ogg_path)
        else:
            if os.path.exists(temp_mp3):
                try:
                    os.remove(temp_mp3)
                except Exception:
                    pass
    except Exception as e:
        if os.path.exists(temp_mp3):
            try:
                os.remove(temp_mp3)
            except Exception:
                pass
        print(f"TTS error: {e}", file=sys.stderr)
        sys.exit(1)

def main():
    if len(sys.argv) < 3:
        print("Usage: python speak.py <text> <output_path>", file=sys.stderr)
        sys.exit(1)
        
    text = sys.argv[1]
    output_path = sys.argv[2]
    
    asyncio.run(generate_speech(text, output_path))

if __name__ == "__main__":
    main()
