defmodule SonicPlayground.Parser do
  @doc """
  Parses a Zola markdown file, splitting the TOML front matter and the markdown body.
  Returns a tuple {toml_map, body}.
  """
  def parse_file(file_path) do
    case File.read(file_path) do
      {:ok, content} ->
        {toml, body} = split(content)
        {:ok, toml} = Toml.decode(toml)
        {toml, body}

      {:error, reason} ->
        {:error, "Failed to read file: #{reason}"}
    end
  end

  defp split(content) do
    # Zola uses +++ to delimit TOML front matter
    [toml, body] = Regex.run(~r/\A\+\+\+\n(.+?)\n\+\+\+\n(.+)/s, content, capture: :all_but_first)
    {toml, body}
  end
end
