#!/bin/bash

# Ensure correct usage
if [ "$#" -ne 1 ]; then
    echo "Usage: $0 'artist - song'"
    exit 1
fi

# Load environment variables
# Make sure to source .envrc if you're using direnv
if [ -f .envrc ]; then
    source .envrc
fi

# Extract artist and song from the provided argument
artist_song="$1"
artist=$(echo "$artist_song" | cut -d '-' -f 1 | xargs)
song=$(echo "$artist_song" | cut -d '-' -f 2 | xargs)
title="${artist// /_}-feat-${song// /_}"

# Define relative paths
content_dir="./content"
image_dir="./static/images/thumbnails"
markdown_file="${content_dir}/${title}.md"
image_file="${image_dir}/${title}.jpeg"

# OpenAI API Key and model
OPENAI_API_KEY="${OPENAI_API_KEY}"  # Assumes .envrc contains OPENAI_API_KEY

# Check if API key is available
if [ -z "$OPENAI_API_KEY" ]; then
    echo "ERROR: OPENAI_API_KEY is not set in your environment."
    exit 1
fi

# Define template file location (relative to the script)
template_file="./scripts/prompt_template.txt"

# Step 1: Generate Article Content using ChatGPT
generate_content() {
    if [ ! -f "$template_file" ]; then
        echo "ERROR: Template file not found at $template_file."
        exit 1
    fi

    # Read the prompt template from the file
    prompt=$(cat "$template_file")

    # Make API request to OpenAI
    response=$(curl -s -X POST "https://api.openai.com/v1/chat/completions" \
    -H "Authorization: Bearer $OPENAI_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{
      "model": "gpt-3.5-turbo",
      "messages": [{"role": "user", "content": "'"$prompt"'"}],
      "max_tokens": 800
    }')

    # Extract content from the response
    content=$(echo "$response" | jq -r '.choices[0].message.content')

    # Save the content to the markdown file
    echo "$content" > "$markdown_file"
}

# Step 2: Download Thumbnail Image
download_thumbnail() {
    image_url="https://source.unsplash.com/random/300x300/?music"  # Placeholder image URL
    mkdir -p "$image_dir"  # Ensure the image directory exists
    curl -o "$image_file" "$image_url"
}

# Execute the functions
generate_content
download_thumbnail

echo "Article and thumbnail created:"
echo "Markdown: $markdown_file"
echo "Image: $image_file"
