use crate::module::ModuleBackend;

pub struct CodecModule;
impl ModuleBackend for CodecModule {
    fn id(&self) -> &'static str {
        "codec"
    }
    fn is_stateless(&self) -> bool {
        true
    }
}
