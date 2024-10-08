use rustler::{Encoder, NifResult, Term};
use serde_json::Value;

/// Decodes a TOML string into a generic Elixir term.
#[rustler::nif]
fn decode_toml<'a>(env: rustler::Env<'a>, toml_string: String) -> NifResult<Term<'a>> {
    match toml::from_str::<Value>(&toml_string) {
        Ok(parsed) => Ok(parsed.encode(env)),
        Err(e) => Err(rustler::Error::Term(Box::new(e.to_string()))),
    }
}

/// Encodes a generic Elixir term into a TOML string.
#[rustler::nif]
fn encode_toml(term: Term) -> NifResult<String> {
    let value: Value = term.decode()?;
    match toml::to_string(&value) {
        Ok(toml_string) => Ok(toml_string),
        Err(e) => Err(rustler::Error::Term(Box::new(e.to_string()))),
    }
}

rustler::init!("Elixir.SonicPlayground.Native");